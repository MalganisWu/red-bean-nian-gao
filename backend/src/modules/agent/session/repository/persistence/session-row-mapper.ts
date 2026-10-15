import { z } from 'zod'

import { storedRuntimeStateSchema } from '../../../execution/adapter/runtime-schema.js'
import type {
  Card,
  DisplayMessage,
  MessageMeta,
} from '../../../presentation/model/display-message.js'
import type { Session, SessionSummary } from '../../model/session.js'
import { optionalField } from '../../../../../shared/object/optional-field.js'

/** card 的宽松结构；`data` 保留为 JSON 对象，具体形状由展示层按 `type` 决定。 */
const cardSchema = z.object({ type: z.string(), data: z.record(z.string(), z.json()) })
/** 定时任务展示元数据的结构，字段按下划线命名对齐持久化格式。 */
const scheduledTaskMetaSchema = z.object({
  task_id: z.string(),
  task_name: z.string(),
  status: z.string(),
  execution_id: z.string(),
  scheduled_at: z.number().finite(),
  completed_at: z.number().finite(),
})
/** 消息元数据的结构；两类字段都可缺省，缺席表示这条消息不带对应信息。 */
const messageMetaSchema = z.object({
  scheduled_task: scheduledTaskMetaSchema.optional(),
  run_started_at: z.number().finite().optional(),
})
/** 展示消息的结构；除 role 与 timestamp 外均可缺省，容纳不同消息类型的形状差异。 */
const displayMessageSchema = z.object({
  role: z.string(),
  content: z.string().optional(),
  cards: z.array(cardSchema).optional(),
  sections: z.json().optional(),
  source: z.string().optional(),
  meta: messageMetaSchema.optional(),
  timestamp: z.number().finite(),
})
/**
 * 会话表行的结构，与 `SESSION_COLUMNS` 的列一一对应；是 PostgreSQL 信任边界的校验入口。
 * revision / fencing_token 接受三种形态不是随手放宽：`pg` 默认把 BIGINT 以字符串返回
 * （超出 JS 安全整数范围，不能用 number），但驱动配置不同或走了别的路径时也可能是 number 或 bigint。
 * 与其假设驱动行为，不如在边界上把三种都收下来再统一转成 bigint（见 toBigInt）。
 */
const sessionRowSchema = z.object({
  session_id: z.string(),
  user_id: z.string(),
  runtime_state: storedRuntimeStateSchema.nullable(),
  display_messages: z.array(displayMessageSchema),
  revision: z.union([z.string(), z.number().int(), z.bigint()]),
  fencing_token: z.union([z.string(), z.number().int(), z.bigint()]),
  updated_at: z.date(),
})
/** 会话所有权投影行的结构；只用于归属判断，两个版本字段可缺省。 */
const sessionOwnerSchema = z.object({
  user_id: z.string(),
  revision: z.union([z.string(), z.number().int(), z.bigint()]).optional(),
  fencing_token: z.union([z.string(), z.number().int(), z.bigint()]).optional(),
})
/** 单列 `revision` 的行结构，用于 `RETURNING revision` 结果的校验。 */
const revisionSchema = z.object({ revision: z.union([z.string(), z.number().int(), z.bigint()]) })
/** 单列 `token` 的行结构，用于 `nextval(...) AS token` 结果的校验。 */
const tokenSchema = z.object({ token: z.union([z.string(), z.number().int(), z.bigint()]) })

/** 会话所有权行的最小投影；`revision`/`fencing_token` 可缺省，只看归属的调用方不必读版本号。 */
export interface SessionOwnerRow {
  /** 记录归属的用户 id；归属判断的唯一依据。 */
  readonly user_id: string
  /** 当前乐观并发版本号；只做归属判断时无需读取，故可缺省。 */
  readonly revision?: string | number | bigint | undefined
  /** 当前 fencing 令牌；同样只做归属判断时可缺省。 */
  readonly fencing_token?: string | number | bigint | undefined
}

/**
 * 在 PostgreSQL 信任边界校验并转换 Session 聚合。
 *
 * @param value - 数据库返回的原始行，形状不可信，一律经 Schema 校验后才使用。
 * @returns 校验通过的会话聚合；行结构不符时抛错，不返回部分字段。
 */
export function parseSession(value: unknown): Session {
  const parsed = sessionRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('会话行数据非法', { cause: parsed.error })
  const row = parsed.data
  return {
    id: row.session_id,
    userId: row.user_id,
    ...optionalField('runtimeState', row.runtime_state),
    displayMessages: row.display_messages.map(toDisplayMessage),
    revision: toBigInt(row.revision, 'revision'),
    fencingToken: toBigInt(row.fencing_token, 'fencing token'),
  }
}

/**
 * 将同一份持久化行映射为列表查询所需的只读摘要。
 *
 * @param value - 数据库返回的原始行，与 `parseSession` 共用同一份 Schema。
 * @returns 摘要；标题由首条用户消息截断而来，行结构不符时抛错。
 */
export function parseSessionSummary(value: unknown): SessionSummary {
  const parsed = sessionRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('会话行数据非法', { cause: parsed.error })
  const messages = parsed.data.display_messages.map(toDisplayMessage)
  return {
    id: parsed.data.session_id,
    title: extractTitle(messages),
    messageCount: messages.length,
    updatedAt: parsed.data.updated_at,
  }
}

/**
 * 解析会话所有权行；两个版本字段缺省是合法的，只做归属判断时用不到它们。
 *
 * @param value - 数据库返回的所有权投影行，形状不可信。
 * @returns 所有权行；`revision`/`fencing_token` 可能缺省，调用方自行判空。
 */
export function parseSessionOwner(value: unknown): SessionOwnerRow {
  const parsed = sessionOwnerSchema.safeParse(value)
  if (!parsed.success) throw new Error('会话归属行数据非法', { cause: parsed.error })
  return parsed.data
}

/**
 * 解析单列 `revision`；用于写入前拿到当前版本，作为 CAS 的比较基准。
 *
 * @param value - `RETURNING revision` 返回的单行结果。
 * @returns 转成 bigint 的版本号；负数或非法形态一律抛错。
 */
export function parseRevision(value: unknown): bigint {
  const parsed = revisionSchema.safeParse(value)
  if (!parsed.success) throw new Error('会话 revision 行数据非法', { cause: parsed.error })
  return toBigInt(parsed.data.revision, 'revision')
}

/**
 * 解析单列 `fencing_token`；续租或写入前用它确认自己仍持有围栏。
 *
 * @param value - `SELECT nextval(...) AS token` 返回的单行结果。
 * @returns 转成 bigint 的围栏序号；负数或非法形态一律抛错。
 */
export function parseFencingToken(value: unknown): bigint {
  const parsed = tokenSchema.safeParse(value)
  if (!parsed.success) throw new Error('会话 fencing token 行数据非法', { cause: parsed.error })
  return toBigInt(parsed.data.token, 'fencing token')
}

/**
 * 把数据库里的三种形态统一成 bigint，并拒绝负数。
 * 负数在这里没有语义（revision 与 fencing token 都只增不减），
 * 出现负值说明数据被写坏了——静默接受会让它一路传到 CAS 比较里，变成一个无法解释的冲突。
 *
 * @param value - 待转换的原始值，可能是驱动返回的字符串、数字或 bigint。
 * @param name - 字段名，只用于拼装错误信息，便于从日志里认出是哪一列出的问题。
 * @returns 非负 bigint。
 */
export function toBigInt(value: string | number | bigint, name: string): bigint {
  try {
    const parsed = BigInt(value)
    if (parsed < 0n) throw new Error(`${name} 不能为负数`)
    return parsed
  } catch (cause: unknown) {
    throw new Error(`${name} 非法`, { cause })
  }
}

/**
 * 把校验过的持久化行映射回领域展示消息；可选字段用 `optionalField` 收口，
 * 使「缺席」与「显式 undefined」在结果里是同一种表示。
 *
 * @param value - 已经过 Schema 校验的展示消息行。
 * @returns 领域展示消息。
 */
function toDisplayMessage(value: z.infer<typeof displayMessageSchema>): DisplayMessage {
  const cards: readonly Card[] | undefined = value.cards?.map((card): Card => ({
    type: card.type,
    data: card.data,
  }))
  const meta = value.meta === undefined ? undefined : toMessageMeta(value.meta)
  return {
    role: value.role,
    ...optionalField('content', value.content),
    ...optionalField('cards', cards),
    ...optionalField('sections', value.sections),
    ...optionalField('source', value.source),
    ...optionalField('meta', meta),
    timestamp: value.timestamp,
  }
}

/**
 * 把校验过的元数据行映射回领域结构，并按需把下划线字段改名成驼峰。
 *
 * @param value - 已经过 Schema 校验的元数据行。
 * @returns 领域消息元数据。
 */
function toMessageMeta(value: z.infer<typeof messageMetaSchema>): MessageMeta {
  return {
    ...(value.scheduled_task === undefined
      ? {}
      : {
          scheduledTask: {
            taskId: value.scheduled_task.task_id,
            taskName: value.scheduled_task.task_name,
            status: value.scheduled_task.status,
            executionId: value.scheduled_task.execution_id,
            scheduledAt: value.scheduled_task.scheduled_at,
            completedAt: value.scheduled_task.completed_at,
          },
        }),
    ...optionalField('runStartedAt', value.run_started_at),
  }
}

/**
 * 取首条用户消息作为标题；`Array.from` 按码点切，避免把 emoji 或星形平面汉字截成半个。
 *
 * @param messages - 会话的展示消息列表，按时间顺序。
 * @returns 截断后的标题；没有可用用户消息时为空串。
 */
function extractTitle(messages: readonly DisplayMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user' || message.content === undefined) continue
    const characters = Array.from(message.content)
    return characters.length > 30 ? `${characters.slice(0, 30).join('')}...` : message.content
  }
  return ''
}
