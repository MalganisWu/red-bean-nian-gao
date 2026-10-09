import type { AgentExecutionOutcome } from '../../../execution/port/agent-executor.js'
import type { StoredRuntimeState } from '../../../execution/model/runtime-state.js'
import type { AgentMessage } from '../../../model/agent-message.js'
import type { AgentJsonObject, AgentJsonValue } from '../../../model/json-value.js'
import { serializeAgentMessage } from '../../../serialization/agent-message-serializer.js'
import type { ChildExecutionIdentity } from '../port/child-execution-lifecycle.port.js'
import {
  SUB_EXECUTION_STATUSES,
  type SubExecutionRecord,
  type SubExecutionStatus,
} from '../../model/sub-execution.js'
import {
  serializeSubAgentSectionData,
  type SubAgentSectionData,
} from '../../service/subagent-display.js'

export interface BuildSubExecutionDisplayRequest extends SubAgentSectionData {
  readonly status: SubExecutionStatus
}

export interface SubExecutionCompletionOptions {
  readonly agentName: string
  readonly modelName?: string | undefined
  readonly systemPrompt?: string | undefined
}

/** 供父 Session 展示投影嵌入子执行结果的稳定载荷。 */
export function buildSubExecutionDisplay(
  request: BuildSubExecutionDisplayRequest
): AgentJsonObject {
  return serializeSubAgentSectionData(request)
}

/** 把一次执行结果完整写回可持久化记录，避免生命周期编排掺杂字段映射。 */
export function updateCompletedRecord(
  record: SubExecutionRecord,
  identity: ChildExecutionIdentity,
  now: Date,
  status: SubExecutionStatus,
  errorMessage: string | undefined,
  pendingInterruptId: string | undefined,
  resultSummary: string,
  display: AgentJsonValue | undefined,
  messages: readonly AgentMessage[],
  runtimeState: StoredRuntimeState | undefined,
  tokensUsed: number,
  options: SubExecutionCompletionOptions
): void {
  record.agentName = options.agentName
  record.userMessage = firstUserMessage(identity.messages)
  record.systemPrompt = emptyToUndefined(options.systemPrompt)
  record.display = display ?? messages.map(serializeAgentMessage)
  record.runtimeState = runtimeState
  record.recoveryMessages = []
  record.modelName = emptyToUndefined(options.modelName)
  record.tokensUsed = tokensUsed
  record.elapsedMilliseconds = Math.max(0, now.valueOf() - record.createdAt.valueOf())
  record.status = status
  record.pendingInterruptId = emptyToUndefined(pendingInterruptId)
  record.errorMessage = errorMessage
  record.resultSummary = emptyToUndefined(resultSummary)
  record.updatedAt = now
  record.completedAt = now
  if (identity.parentCallId !== '') record.parentCallId = identity.parentCallId
}

export function executionStatus(
  outcome: AgentExecutionOutcome | undefined,
  executionError: Error | undefined
): { readonly status: SubExecutionStatus; readonly errorMessage?: string | undefined } {
  if (outcome === undefined) {
    return {
      status: SUB_EXECUTION_STATUSES.FAILED,
      errorMessage: executionError?.message ?? '子 Agent 执行失败',
    }
  }
  switch (outcome.status) {
    case 'completed':
      return { status: SUB_EXECUTION_STATUSES.COMPLETED }
    case 'suspended':
      return { status: SUB_EXECUTION_STATUSES.AWAITING_USER }
    case 'cancelled':
      return { status: SUB_EXECUTION_STATUSES.FAILED, errorMessage: '子 Agent 被取消' }
    case 'exhausted':
      return {
        status: SUB_EXECUTION_STATUSES.FAILED,
        errorMessage: '子 Agent 达到最大工具迭代次数，任务未完成',
      }
    case 'failed':
      return {
        status: SUB_EXECUTION_STATUSES.FAILED,
        errorMessage: executionError?.message ?? '子 Agent LLM 调用失败',
      }
  }
}

export function firstUserMessage(messages: readonly AgentMessage[]): string {
  for (const message of messages) {
    if (message.role === 'user' && message.content !== null) return message.content
  }
  return ''
}

export function lastAssistantContent(messages: readonly AgentMessage[]): string {
  for (const message of messages.toReversed()) {
    if (message.role === 'assistant' && message.content !== null && message.content !== '')
      return message.content
  }
  return ''
}

export function isJsonValue(value: unknown): value is AgentJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return typeof value === 'object' && value !== null && Object.values(value).every(isJsonValue)
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}
