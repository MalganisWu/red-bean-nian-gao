import { z } from 'zod'

import {
  RUN_COMPACTION_STATUSES,
  RUN_COMPACTION_TRIGGERS,
  RUN_FACT_SCHEMA_VERSION,
  RUN_FACT_TYPES,
  RUN_TOOL_STATUSES,
  type RunFact,
} from '../model/run-fact.js'
import { RUN_FACT_STORE_ERROR_CODES, RunFactStoreError } from '../model/run-fact-store-error.js'
import {
  SESSION_RUN_CANCELLED_BY,
  SESSION_RUN_STATUSES,
  type SessionRunCancelledBy,
  type SessionRunRecord,
} from '../model/session-run.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

// PostgreSQL 信任边界：session_runs 的 JSONB（facts/header）与列值一律从 unknown 开始校验，
// 映射惯例与 session-row-mapper.ts 保持一致。
//
// 每条事实都自带 `schemaVersion`，读取端的纪律见 parseRunFacts：
// 不认识的类型/版本，带 `ignorable` 标记的跳过、否则整批拒绝。
// `ignorable` 由**写入端**在「这条记录丢了对审计不影响判断」时打上——
// 这个决定只有写入方做得出来，读取方无从推断，所以标记落在数据里而不是代码里。

/** 单次 attempt 的 token 用量形状；cacheReadTokens 允许为 null（供应商未上报缓存命中）。 */
const usageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
})

/** 一次 LLM attempt 的校验形状；endedAt 必有，未闭合的 attempt 在固化时已补成 startedAt。 */
const attemptSchema = z.object({
  attempt: z.number().int().positive(),
  startedAt: z.number().finite(),
  endedAt: z.number().finite(),
  usage: usageSchema.nullable(),
  error: z.string().optional(),
})

/** user 事实的校验形状；ignorable 只可能是字面量 true，用于标记可安全跳过的记录。 */
const userFactSchema = z.object({
  type: z.literal(RUN_FACT_TYPES.USER),
  content: z.string(),
  source: z.string().optional(),
  at: z.number().finite(),
  schemaVersion: z.number().int(),
  ignorable: z.literal(true).optional(),
})

/** assistant 事实的校验形状；attempts 承载空响应重试留下的全部 attempt，供回放。 */
const assistantFactSchema = z.object({
  type: z.literal(RUN_FACT_TYPES.ASSISTANT),
  at: z.number().finite(),
  durationMs: z.number().int().nonnegative(),
  usage: usageSchema.nullable(),
  attempts: z.array(attemptSchema),
  thinking: z.string(),
  content: z.string(),
  schemaVersion: z.number().int(),
  ignorable: z.literal(true).optional(),
})

/** compaction 事实的校验形状；durationMs 可空以兼容未测到耗时的存量摘要记录。 */
const compactionFactSchema = z.object({
  type: z.literal(RUN_FACT_TYPES.COMPACTION),
  at: z.number().finite(),
  trigger: z.enum([RUN_COMPACTION_TRIGGERS.AUTO, RUN_COMPACTION_TRIGGERS.MANUAL]),
  beforeTokens: z.number().int().nonnegative(),
  afterTokens: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().nullable(),
  status: z.enum([
    RUN_COMPACTION_STATUSES.SUCCESS,
    RUN_COMPACTION_STATUSES.FAILED,
    RUN_COMPACTION_STATUSES.INTERRUPTED,
  ]),
  schemaVersion: z.number().int(),
  ignorable: z.literal(true).optional(),
})

/** tool 事实的校验形状；status 可缺省（存量记录按 result/error 推断完成或失败）。 */
const toolFactSchema = z.object({
  type: z.literal(RUN_FACT_TYPES.TOOL),
  callId: z.string(),
  name: z.string(),
  params: z.record(z.string(), z.json()).nullable(),
  result: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.number().finite(),
  durationMs: z.number().int().nonnegative(),
  // 缺省 = 按 result/error 推断；存量记录没有该字段，因此 optional 而非 nullable
  status: z.enum([RUN_TOOL_STATUSES.INTERRUPT, RUN_TOOL_STATUSES.INCOMPLETE]).optional(),
  schemaVersion: z.number().int(),
  ignorable: z.literal(true).optional(),
})

/** run 终态机取值集合；与 SESSION_RUN_STATUSES 对齐，未知状态一律拒绝。 */
const sessionRunStatusSchema = z.enum([
  SESSION_RUN_STATUSES.RUNNING,
  SESSION_RUN_STATUSES.COMPLETED,
  SESSION_RUN_STATUSES.FAILED,
  SESSION_RUN_STATUSES.CANCELLED,
  SESSION_RUN_STATUSES.INTERRUPTED,
  SESSION_RUN_STATUSES.EXHAUSTED,
])

/** 取消归属取值集合；区分用户主动取消与系统（超时等）取消。 */
const sessionRunCancelledBySchema = z.enum([
  SESSION_RUN_CANCELLED_BY.USER,
  SESSION_RUN_CANCELLED_BY.SYSTEM,
])

/** session_runs 查询行的列投影；facts 为 JSONB 数组，日期列为 TIMESTAMPTZ。 */
export const SESSION_RUN_ROW_COLUMNS = `
  run_id,
  session_id,
  user_id,
  run_index,
  provider,
  model,
  context_window,
  status,
  cancelled_at,
  cancelled_by,
  error,
  started_at,
  ended_at,
  header,
  facts,
  schema_version
`

/** session_runs 查询行的校验形状；facts 为待逐条二次校验的 JSONB 数组。 */
const sessionRunRowSchema = z.object({
  run_id: z.string(),
  session_id: z.string(),
  user_id: z.string(),
  run_index: z.number().int(),
  provider: z.string(),
  model: z.string(),
  context_window: z.number().int().nullable(),
  status: sessionRunStatusSchema,
  cancelled_at: z.date().nullable(),
  cancelled_by: sessionRunCancelledBySchema.nullable(),
  error: z.string().nullable(),
  started_at: z.date(),
  ended_at: z.date().nullable(),
  header: z.json().nullable(),
  facts: z.array(z.json()),
  schema_version: z.number().int(),
})

/**
 * 校验并映射 session_runs 查询行；run 容器与内部事实序列在此完成信任边界转换。
 * 事实序列中的未知类型按版本纪律处理（ignorable 跳过 / 否则拒绝），见 parseRunFacts。
 *
 * @param value - 数据库返回的 unknown 行；结构不符即抛 RunFactStoreError
 * @returns 通过校验的会话 run 记录
 */
export function parseSessionRunRecord(value: unknown): SessionRunRecord {
  const parsed = sessionRunRowSchema.safeParse(value)
  if (!parsed.success) {
    throw new RunFactStoreError(RUN_FACT_STORE_ERROR_CODES.FACTS_UNREADABLE, 'run 容器行无效', {
      cause: parsed.error,
    })
  }
  const row = parsed.data
  const cancelledBy = toCancelledBy(row.cancelled_by)
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    userId: row.user_id,
    runIndex: row.run_index,
    provider: row.provider,
    model: row.model,
    contextWindow: row.context_window,
    status: row.status,
    ...(cancelledAt(row.cancelled_at) === undefined
      ? {}
      : { cancelledAt: cancelledAt(row.cancelled_at) }),
    ...optionalField('cancelledBy', cancelledBy),
    ...(row.error === null || row.error === '' ? {} : { error: row.error }),
    startedAt: row.started_at.getTime(),
    endedAt: toEpochMs(row.ended_at),
    ...optionalField('header', row.header),
    facts: parseRunFacts(row.facts),
    schemaVersion: row.schema_version,
  }
}

/**
 * 事实日志的版本纪律读取端（R9）：遇到不认识的记录——
 * 带 `ignorable` 标记的跳过，否则拒绝并明确报错，绝不静默误读。
 *
 * @param value - 事实日志 JSONB（unknown）；非数组或含非法记录即抛 RunFactStoreError
 * @returns 通过校验的事实序列
 */
export function parseRunFacts(value: unknown): readonly RunFact[] {
  if (!Array.isArray(value)) {
    throw new RunFactStoreError(RUN_FACT_STORE_ERROR_CODES.FACTS_UNREADABLE, '事实日志必须是数组')
  }
  const facts: RunFact[] = []
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new RunFactStoreError(
        RUN_FACT_STORE_ERROR_CODES.FACTS_UNREADABLE,
        '事实日志包含非对象记录'
      )
    }
    const type = entry['type']
    const ignorable = entry['ignorable'] === true
    if (typeof type !== 'string' || !isKnownFactType(type)) {
      if (ignorable) continue
      throw new RunFactStoreError(
        RUN_FACT_STORE_ERROR_CODES.FACTS_UNREADABLE,
        `事实日志包含未知的事实类型: ${JSON.stringify(type ?? null)}`
      )
    }
    const schemaVersion = entry['schemaVersion']
    if (schemaVersion !== RUN_FACT_SCHEMA_VERSION) {
      // 已知类型但版本更新（或缺失版本）：读取端无法保证字段语义，同样按 ignorable 纪律处理。
      if (ignorable) continue
      throw new RunFactStoreError(
        RUN_FACT_STORE_ERROR_CODES.FACTS_UNREADABLE,
        `事实日志 schema 版本不受支持: 期望 ${String(RUN_FACT_SCHEMA_VERSION)}，实际 ${JSON.stringify(schemaVersion ?? null)}`
      )
    }
    facts.push(parseKnownFact(entry, type))
  }
  return facts
}

/**
 * 按 type 选对应 schema 校验一条已知事实并映射为领域对象；
 * 调用方已保证 type 属于已知集合且版本一致，这里只做字段级校验与可空字段归一。
 * @param entry 事实日志里的一条原始对象；形状不符即抛 RunFactStoreError
 * @param type 已判定为已知的事实类型，用于选 schema
 * @returns 通过校验的领域事实
 */
function parseKnownFact(entry: Record<string, unknown>, type: string): RunFact {
  const schema =
    type === RUN_FACT_TYPES.USER
      ? userFactSchema
      : type === RUN_FACT_TYPES.ASSISTANT
        ? assistantFactSchema
        : type === RUN_FACT_TYPES.COMPACTION
          ? compactionFactSchema
          : toolFactSchema
  const parsed = schema.safeParse(entry)
  if (!parsed.success) {
    throw new RunFactStoreError(
      RUN_FACT_STORE_ERROR_CODES.FACTS_UNREADABLE,
      `事实日志记录无效: ${z.prettifyError(parsed.error)}`,
      { cause: parsed.error }
    )
  }
  const fact = parsed.data
  if (fact.type === RUN_FACT_TYPES.USER) {
    return {
      type: fact.type,
      content: fact.content,
      ...optionalField('source', fact.source),
      at: fact.at,
      schemaVersion: fact.schemaVersion,
    }
  }
  if (fact.type === RUN_FACT_TYPES.ASSISTANT) {
    return {
      type: fact.type,
      at: fact.at,
      durationMs: fact.durationMs,
      usage: fact.usage,
      attempts: fact.attempts,
      thinking: fact.thinking,
      content: fact.content,
      schemaVersion: fact.schemaVersion,
    }
  }
  if (fact.type === RUN_FACT_TYPES.COMPACTION) {
    return {
      type: fact.type,
      at: fact.at,
      trigger: fact.trigger,
      beforeTokens: fact.beforeTokens,
      afterTokens: fact.afterTokens,
      messages: fact.messages,
      durationMs: fact.durationMs,
      status: fact.status,
      schemaVersion: fact.schemaVersion,
    }
  }
  return {
    type: fact.type,
    callId: fact.callId,
    name: fact.name,
    params: fact.params,
    ...optionalField('result', fact.result),
    ...optionalField('error', fact.error),
    startedAt: fact.startedAt,
    durationMs: fact.durationMs,
    ...optionalField('status', fact.status),
    schemaVersion: fact.schemaVersion,
  }
}

/**
 * 判定字符串是否为当前已知的事实类型；未知类型由调用方按 ignorable 纪律决定跳过或拒绝。
 * @param type 事实记录里的 type 字段
 * @returns 属于已知类型时为 true
 */
function isKnownFactType(type: string): boolean {
  return (
    type === RUN_FACT_TYPES.USER ||
    type === RUN_FACT_TYPES.ASSISTANT ||
    type === RUN_FACT_TYPES.TOOL ||
    type === RUN_FACT_TYPES.COMPACTION
  )
}

/**
 * 判定事实日志条目是否为非数组对象；逐条校验前先排除数组与 null。
 * @param value 待判定的未知值
 * @returns 是非数组对象时为 true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把数据库的 null 取消归属归一为 undefined；领域模型里「缺失」与「显式 null」都表示无归属。
 * @param value 数据库读出的取消归属，可为 null
 * @returns 取消归属；数据库为 null 时为 undefined
 */
function toCancelledBy(value: SessionRunCancelledBy | null): SessionRunCancelledBy | undefined {
  return value ?? undefined
}

/**
 * 把取消时刻的 nullable 日期列映射为 epoch 毫秒；null 归一为 undefined，便于可选字段整体省略。
 * @param value 取消时刻日期列，可为 null
 * @returns 取消时刻的 epoch 毫秒；列为 null 时为 undefined
 */
function cancelledAt(value: Date | null): number | undefined {
  return value === null ? undefined : value.getTime()
}

/**
 * 把 nullable 日期列映射为 epoch 毫秒并保留 null 语义；endedAt 的 null 表示 run 尚未结束。
 * @param value 日期列，可为 null
 * @returns epoch 毫秒；列为 null 时为 null
 */
function toEpochMs(value: Date | null): number | null {
  return value === null ? null : value.getTime()
}
