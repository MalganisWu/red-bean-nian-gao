import { z } from 'zod'

import { storedRuntimeStateSchema } from '../../../execution/adapter/runtime-schema.js'
import type { AgentMessage, AgentToolCall } from '../../../model/agent-message.js'
import { SUB_EXECUTION_STATUSES, type SubExecutionRecord } from '../../model/sub-execution.js'
import { optionalField } from '../../../../../shared/object/optional-field.js'

/** 数据库可空文本列的 schema；缺值统一落成 `null`，不用 undefined 表达「无值」。 */
const nullableStringSchema = z.string().nullable()
/** 数据库可空时间列的 schema，如 completed_at；子执行尚未完成时为 null。 */
const nullableDateSchema = z.date().nullable()
/** 恢复消息里单条工具调用的 schema；字段用 snake_case 与 OpenAI 兼容协议保持一致。 */
const toolCallSchema = z.object({
  index: z.number().int().optional(),
  id: z.string(),
  type: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }),
})
/**
 * 恢复缓冲消息的 schema；role / content 只做宽松字符串校验，
 * 目的仅是保证结构能被领域层安全消费，不在这里收紧业务语义。
 */
const recoveryMessageSchema = z.object({
  role: z.string(),
  content: z.string().nullable(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
})
/**
 * 子执行行 schema：数据库 unknown 行进入领域前的唯一结构校验点。
 * 列名用 snake_case 与表结构一一对应，`status` 用枚举约束到已知子执行状态。
 */
const subExecutionRowSchema = z.object({
  execution_id: z.string(),
  session_id: z.string(),
  request_id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  user_id: z.string(),
  user_message: z.string(),
  system_prompt: nullableStringSchema,
  display_messages: z.json(),
  runtime_state: storedRuntimeStateSchema.nullable(),
  recovery_messages: z.array(recoveryMessageSchema),
  model_name: nullableStringSchema,
  tokens_used: z.number().int(),
  elapsed_ms: z.number().int(),
  status: z.enum([
    SUB_EXECUTION_STATUSES.PENDING,
    SUB_EXECUTION_STATUSES.RUNNING,
    SUB_EXECUTION_STATUSES.COMPLETED,
    SUB_EXECUTION_STATUSES.FAILED,
    SUB_EXECUTION_STATUSES.INTERRUPTED,
    SUB_EXECUTION_STATUSES.AWAITING_USER,
  ]),
  pending_interrupt_id: nullableStringSchema,
  result_summary: nullableStringSchema,
  error_msg: nullableStringSchema,
  parent_call_id: nullableStringSchema,
  created_at: z.date(),
  updated_at: z.date(),
  completed_at: nullableDateSchema,
  revision: z.union([z.string(), z.number().int(), z.bigint()]),
})

/** PostgreSQL 子执行列清单，查询与插入共用以防字段漂移。 */
export const SUB_EXECUTION_COLUMNS = `
  execution_id, session_id, request_id, agent_id, agent_name, user_id, user_message,
  system_prompt, display_messages, runtime_state, recovery_messages, model_name, tokens_used, elapsed_ms,
  status, pending_interrupt_id, result_summary, error_msg, parent_call_id, created_at, updated_at,
  completed_at, revision
`

/**
 * 将领域记录序列化为 INSERT 参数，不让 SQL 字段泄漏到生命周期服务。
 *
 * @param record - 待序列化的领域记录；可选字段缺省时写 null
 * @returns 与 SUB_EXECUTION_COLUMNS 顺序一致的参数数组
 */
export function subExecutionValues(record: SubExecutionRecord): readonly unknown[] {
  return [
    record.executionId,
    record.sessionId,
    record.requestId,
    record.agentId,
    record.agentName,
    record.userId,
    record.userMessage,
    record.systemPrompt ?? null,
    JSON.stringify(record.display),
    record.runtimeState === undefined ? null : JSON.stringify(record.runtimeState),
    JSON.stringify(record.recoveryMessages.map(serializeRecoveryMessage)),
    record.modelName ?? null,
    record.tokensUsed,
    record.elapsedMilliseconds,
    record.status,
    record.pendingInterruptId ?? null,
    record.resultSummary ?? null,
    record.errorMessage ?? null,
    record.parentCallId ?? null,
    record.createdAt,
    record.updatedAt,
    record.completedAt ?? null,
    record.revision,
  ]
}

/**
 * 数据库 unknown row 在进入领域前必须完成结构校验和命名转换。
 *
 * @param value - 数据库返回的 unknown 行；结构不符即抛错，绝不带脏数据进领域
 * @returns 通过校验并转换命名后的领域记录
 */
export function mapSubExecutionRow(value: unknown): SubExecutionRecord {
  const parsed = subExecutionRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('子执行行数据非法', { cause: parsed.error })
  const row = parsed.data
  return {
    executionId: row.execution_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    userId: row.user_id,
    userMessage: row.user_message,
    ...optionalField('systemPrompt', row.system_prompt),
    display: row.display_messages,
    ...optionalField('runtimeState', row.runtime_state),
    recoveryMessages: row.recovery_messages.map(mapRecoveryMessage),
    ...optionalField('modelName', row.model_name),
    tokensUsed: row.tokens_used,
    elapsedMilliseconds: row.elapsed_ms,
    status: row.status,
    ...optionalField('pendingInterruptId', row.pending_interrupt_id),
    ...optionalField('resultSummary', row.result_summary),
    ...optionalField('errorMessage', row.error_msg),
    ...optionalField('parentCallId', row.parent_call_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...optionalField('completedAt', row.completed_at),
    revision: BigInt(row.revision),
  }
}

/**
 * 把领域消息序列化为 OpenAI 兼容的 snake_case 行；缺省字段直接省略而不是写 null，
 * 让读回的 `optionalField` 能区分「未提供」与「显式为 null」。
 *
 * @param message - 待序列化的领域消息。
 * @returns 可写入 JSONB 列的载荷；toolCalls / toolCallId / name 缺失时不出现该键。
 */
function serializeRecoveryMessage(message: AgentMessage): unknown {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls === undefined
      ? {}
      : {
          tool_calls: message.toolCalls.map((call) => ({
            ...optionalField('index', call.index),
            id: call.id,
            type: call.type,
            function: call.function,
          })),
        }),
    ...optionalField('tool_call_id', message.toolCallId),
    ...optionalField('name', message.name),
  }
}

/**
 * 把已通过 schema 校验的恢复消息行转回领域消息，命名从 snake_case 还原为 camelCase。
 *
 * @param message - 通过 `recoveryMessageSchema` 校验的行数据。
 * @returns 领域消息；可选字段按「有则带、无则省」重建。
 */
function mapRecoveryMessage(message: z.infer<typeof recoveryMessageSchema>): AgentMessage {
  const toolCalls: readonly AgentToolCall[] | undefined = message.tool_calls?.map(
    (call): AgentToolCall => ({
      ...optionalField('index', call.index),
      id: call.id,
      type: call.type,
      function: call.function,
    })
  )
  return {
    role: message.role,
    content: message.content,
    ...optionalField('toolCalls', toolCalls),
    ...optionalField('toolCallId', message.tool_call_id),
    ...optionalField('name', message.name),
  }
}
