import { z } from 'zod'

import { storedRuntimeStateSchema } from '../../../execution/adapter/runtime-schema.js'
import type {
  Card,
  DisplayMessage,
  MessageMeta,
} from '../../../presentation/model/display-message.js'
import type { Session, SessionSummary } from '../../model/session.js'
import { optionalField } from '../../../../../shared/object/optional-field.js'

const cardSchema = z.object({ type: z.string(), data: z.record(z.string(), z.json()) })
const scheduledTaskMetaSchema = z.object({
  task_id: z.string(),
  task_name: z.string(),
  status: z.string(),
  execution_id: z.string(),
  scheduled_at: z.number().finite(),
  completed_at: z.number().finite(),
})
const messageMetaSchema = z.object({
  scheduled_task: scheduledTaskMetaSchema.optional(),
  run_started_at: z.number().finite().optional(),
})
const displayMessageSchema = z.object({
  role: z.string(),
  content: z.string().optional(),
  cards: z.array(cardSchema).optional(),
  sections: z.json().optional(),
  source: z.string().optional(),
  meta: messageMetaSchema.optional(),
  timestamp: z.number().finite(),
})
/*
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
const sessionOwnerSchema = z.object({
  user_id: z.string(),
  revision: z.union([z.string(), z.number().int(), z.bigint()]).optional(),
  fencing_token: z.union([z.string(), z.number().int(), z.bigint()]).optional(),
})
const revisionSchema = z.object({ revision: z.union([z.string(), z.number().int(), z.bigint()]) })
const tokenSchema = z.object({ token: z.union([z.string(), z.number().int(), z.bigint()]) })

export interface SessionOwnerRow {
  readonly user_id: string
  readonly revision?: string | number | bigint | undefined
  readonly fencing_token?: string | number | bigint | undefined
}

/** 在 PostgreSQL 信任边界校验并转换 Session 聚合。 */
export function parseSession(value: unknown): Session {
  const parsed = sessionRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('invalid session row', { cause: parsed.error })
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

/** 将同一份持久化行映射为列表查询所需的只读摘要。 */
export function parseSessionSummary(value: unknown): SessionSummary {
  const parsed = sessionRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('invalid session row', { cause: parsed.error })
  const messages = parsed.data.display_messages.map(toDisplayMessage)
  return {
    id: parsed.data.session_id,
    title: extractTitle(messages),
    messageCount: messages.length,
    updatedAt: parsed.data.updated_at,
  }
}

export function parseSessionOwner(value: unknown): SessionOwnerRow {
  const parsed = sessionOwnerSchema.safeParse(value)
  if (!parsed.success) throw new Error('invalid session owner row', { cause: parsed.error })
  return parsed.data
}

export function parseRevision(value: unknown): bigint {
  const parsed = revisionSchema.safeParse(value)
  if (!parsed.success) throw new Error('invalid session revision row', { cause: parsed.error })
  return toBigInt(parsed.data.revision, 'revision')
}

export function parseFencingToken(value: unknown): bigint {
  const parsed = tokenSchema.safeParse(value)
  if (!parsed.success) throw new Error('invalid session fencing token row', { cause: parsed.error })
  return toBigInt(parsed.data.token, 'fencing token')
}

/**
 * 把数据库里的三种形态统一成 bigint，并拒绝负数。
 * 负数在这里没有语义（revision 与 fencing token 都只增不减），
 * 出现负值说明数据被写坏了——静默接受会让它一路传到 CAS 比较里，变成一个无法解释的冲突。
 */
export function toBigInt(value: string | number | bigint, name: string): bigint {
  try {
    const parsed = BigInt(value)
    if (parsed < 0n) throw new Error(`${name} must not be negative`)
    return parsed
  } catch (cause: unknown) {
    throw new Error(`invalid ${name}`, { cause })
  }
}

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

/** 取首条用户消息作为标题；`Array.from` 按码点切，避免把 emoji 或星形平面汉字截成半个。 */
function extractTitle(messages: readonly DisplayMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user' || message.content === undefined) continue
    const characters = Array.from(message.content)
    return characters.length > 30 ? `${characters.slice(0, 30).join('')}...` : message.content
  }
  return ''
}
