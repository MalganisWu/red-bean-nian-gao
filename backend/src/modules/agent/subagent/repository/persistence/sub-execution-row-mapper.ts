import { z } from 'zod'

import { storedRuntimeStateSchema } from '../../../execution/adapter/runtime-schema.js'
import type { AgentMessage, AgentToolCall } from '../../../model/agent-message.js'
import { SUB_EXECUTION_STATUSES, type SubExecutionRecord } from '../../model/sub-execution.js'
import { optionalField } from '../../../../../shared/object/optional-field.js'

const nullableStringSchema = z.string().nullable()
const nullableDateSchema = z.date().nullable()
const toolCallSchema = z.object({
  index: z.number().int().optional(),
  id: z.string(),
  type: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }),
})
const recoveryMessageSchema = z.object({
  role: z.string(),
  content: z.string().nullable(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
})
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

/** 将领域记录序列化为 INSERT 参数，不让 SQL 字段泄漏到生命周期服务。 */
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

/** 数据库 unknown row 在进入领域前必须完成结构校验和命名转换。 */
export function mapSubExecutionRow(value: unknown): SubExecutionRecord {
  const parsed = subExecutionRowSchema.safeParse(value)
  if (!parsed.success) throw new Error('invalid sub execution row', { cause: parsed.error })
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
