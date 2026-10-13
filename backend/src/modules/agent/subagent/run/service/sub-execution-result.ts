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

/** 造展示载荷的入参；在 section 数据之上补一个领域状态（`SubAgentSectionData.status` 是裸字符串）。 */
export interface BuildSubExecutionDisplayRequest extends SubAgentSectionData {
  readonly status: SubExecutionStatus
}

/** 终态写入时的展示字段；空串与 `undefined` 一律按「未提供」处理，不会写进记录。 */
export interface SubExecutionCompletionOptions {
  readonly agentName: string
  readonly modelName?: string | undefined
  readonly systemPrompt?: string | undefined
}

/**
 * 供父 Session 展示投影嵌入子执行结果的稳定载荷。
 *
 * @param request - 展示载荷入参：section 数据外加一个领域 status
 * @returns 落库用的 snake_case JSON 载荷
 */
export function buildSubExecutionDisplay(
  request: BuildSubExecutionDisplayRequest
): AgentJsonObject {
  return serializeSubAgentSectionData(request)
}

/**
 * 把一次执行结果完整写回可持久化记录，避免生命周期编排掺杂字段映射。
 *
 * 两处值得注意的取值：
 * - `record.display = display ?? messages.map(serializeAgentMessage)`：没有独立展示 section 时
 *   退回用原始消息，保证记录里**总有**可供展示的内容，前端不必处理「display 为空」的情况。
 * - `record.recoveryMessages = []`：终态写入即意味着增量缓冲已被合并进 `runtimeState`，
 *   清空它，否则下次加载会把同一批消息再恢复一遍。
 *
 * @param record - 就地改写的目标记录；调用方随后经仓储 CAS 写回
 * @param identity - 子执行身份；messages 与 parentCallId 从中取值
 * @param now - 完成时刻；写入 updatedAt / completedAt 并计算耗时
 * @param status - 映射后的产品状态
 * @param errorMessage - 失败原因；成功与挂起时为 undefined
 * @param pendingInterruptId - 待确认的中断 ID；非挂起态为 undefined
 * @param resultSummary - 结果摘要；空串按未提供处理
 * @param display - 独立展示载荷；缺失时退回用 messages 序列化
 * @param messages - 执行产出的会话消息；用于兜底展示与首条指令提取
 * @param runtimeState - 合并后的 Runtime 状态；undefined 时清空记录中的状态
 * @param tokensUsed - 本轮 token 用量
 * @param options - 终态展示字段（agentName / modelName / systemPrompt）；空串按未提供处理
 */
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

/**
 * 把 Runtime 的执行结果映射成产品侧的子执行状态。
 *
 * `completed` 与 `suspended` 一一对应，其余三态**都归到 FAILED**：
 * 从「父 Agent 委派了一个任务」的视角看，被取消、迭代耗尽、报错都是「没拿到结果」，
 * 区别只在 errorMessage 里保留。真正的中间态只有 `AWAITING_USER`——那是在等父 Agent 转达用户确认。
 * `outcome === undefined`（连结果都没拿到）同样计为失败。
 *
 * @param outcome - Runtime 执行结果；undefined 视为失败
 * @param executionError - 执行期错误；为 errorMessage 提供兜底文案
 * @returns 产品侧状态与可选错误信息
 */
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

/**
 * 取第一条 user 消息，作为「这次委派让子 Agent 做了什么」的指令；没有则返回空串。
 *
 * @param messages - 会话消息序列
 * @returns 首条 user 消息正文；无则空串
 */
export function firstUserMessage(messages: readonly AgentMessage[]): string {
  for (const message of messages) {
    if (message.role === 'user' && message.content !== null) return message.content
  }
  return ''
}

/**
 * 取最后一条非空 assistant 正文；倒序扫描，纯工具调用轮次的空正文会被跳过。
 *
 * @param messages - 会话消息序列
 * @returns 最后一条非空 assistant 正文；无则空串
 */
export function lastAssistantContent(messages: readonly AgentMessage[]): string {
  for (const message of messages.toReversed()) {
    if (message.role === 'assistant' && message.content !== null && message.content !== '')
      return message.content
  }
  return ''
}

/**
 * 递归判定是否是可安全落库的 JSON 值。
 * `Number.isFinite` 同时排掉 `NaN`、`±Infinity`——它们能被 `typeof` 判为 number，
 * 却无法在 JSON 里表示（序列化后变成 `null`，读回来就不再是原来的值了）。
 *
 * @param value - 待判定的值；NaN / ±Infinity 视为非法
 * @returns 可安全 JSON 序列化则为 true
 */
export function isJsonValue(value: unknown): value is AgentJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return typeof value === 'object' && value !== null && Object.values(value).every(isJsonValue)
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}
