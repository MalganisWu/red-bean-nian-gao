import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'
import {
  STREAM_EVENT_TYPES,
  type LocalizedStatusEvent,
  type ProductStreamEvent,
  type StreamErrorEvent,
} from '../../run/model/agent-run.js'
import {
  AGENT_EVENT_TYPES,
  AGENT_STATUS_CODES,
  type AgentRuntimeEvent,
  type AgentStatusEvent,
} from '../../run/model/agent-runtime-event.js'
import { SESSION_STORE_ERROR_CODES, SessionStoreError } from '../../session/model/session.js'
import { AppError } from '../../../../shared/http/error-mapper.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

/**
 * 将领域或应用错误映射为不会泄漏内部细节的 SSE 错误事件。
 *
 * 落点是通用的 5000 + 固定文案——SSE 是一条已经打开的流，头部早已发出，
 * 这里没有 HTTP 状态码可用，错误只能以事件形式传递，因此更要小心不要把内部信息写进去。
 * 会话不存在映射为 4004、交互冲突映射为 4009，是给前端做分支用的稳定业务码。
 *
 * @param error - 捕获到的任意异常；仅 `SessionStoreError` / `AppError` 会被翻译成业务码，其余一律折叠为 5000，原始 message 与堆栈都不外泄。
 * @returns 可直接序列化进 SSE 帧的错误事件；`code` 是前端做分支用的稳定业务码。
 */
export function toStreamErrorEvent(error: unknown): StreamErrorEvent {
  if (error instanceof SessionStoreError) {
    if (error.code === SESSION_STORE_ERROR_CODES.NOT_FOUND) {
      return { type: 'error', code: 4004, message: '会话不存在' }
    }
    if (error.code === SESSION_STORE_ERROR_CODES.INTERACTION_CONFLICT) {
      return { type: 'error', code: 4009, message: '交互不存在或已处理' }
    }
  }
  if (error instanceof AppError) {
    return { type: 'error', code: error.code, message: error.message }
  }
  return { type: 'error', code: 5000, message: '服务器内部错误' }
}

/**
 * 在 HTTP 展示边界为 Runtime 状态补充产品文案。
 *
 * `status` 事件会被换成带 `content` 的本地化版本；其余事件原样返回，
 * 但 `agent_event` 信封会**递归下钻**——子 Agent 的 status 同样需要本地化。
 */
export function localizeRuntimeEvent(event: AgentStatusEvent): LocalizedStatusEvent
/** 非 status 事件：原样返回；`agent_event` 信封则递归处理其内层事件。 */
export function localizeRuntimeEvent(event: ProductStreamEvent): ProductStreamEvent
/**
 * 实现体：`status` 交给 `localizedStatus`，`agent_event` 解构信封后递归。
 *
 * @param event - 单个产品事件；`status` 会被本地化，`agent_event` 会递归下钻，其余原样返回。
 * @returns 展示边界上的事件；普通非 status 事件与入参是同一引用，调用方不应据此做身份判断。
 */
export function localizeRuntimeEvent(event: ProductStreamEvent): ProductStreamEvent {
  if (event.type === AGENT_EVENT_TYPES.STATUS) return localizedStatus(event)
  if (event.type !== STREAM_EVENT_TYPES.AGENT_EVENT) return event
  // 信封的 `event` 字段与来源同名：先解构剔除再显式回填，避免展开后又覆盖同一个键。
  const { event: nested, ...envelope } = event
  return { ...envelope, event: localizeRuntimeEvent(nested) }
}

/**
 * 将产品事件序列化为稳定的 SSE 帧。
 *
 * @param event - 待投影的产品事件；本函数只做本地化与 JSON 编码，不改变事件顺序。
 * @returns 一帧 `event:` + `data:` 文本，末尾固定空行分隔；帧序与入参次序一致。
 */
export function serializeSseEvent(event: ProductStreamEvent): string {
  const localized = localizeRuntimeEvent(event)
  return `event: ${localized.type}\ndata: ${JSON.stringify(eventPayload(localized))}\n\n`
}

function eventPayload(event: ProductStreamEvent): AgentJsonObject {
  switch (event.type) {
    case STREAM_EVENT_TYPES.START:
      return {
        request_id: event.requestId,
        session_id: event.sessionId,
        trace_id: event.traceId,
      }
    case STREAM_EVENT_TYPES.DONE:
      return { tokens_used: event.tokensUsed, session_id: event.sessionId }
    case STREAM_EVENT_TYPES.ERROR:
      return { code: event.code, message: event.message }
    case STREAM_EVENT_TYPES.HEARTBEAT:
      return { timestamp: event.timestamp }
    case STREAM_EVENT_TYPES.CARD:
      return {
        interaction_id: event.interactionId,
        status: event.status,
        questions: event.questions,
      }
    case STREAM_EVENT_TYPES.AGENT_EVENT:
      return {
        agent_id: event.agentId,
        agent_name: event.agentName,
        execution_id: event.executionId,
        parent_call_id: event.parentCallId,
        event_type: event.eventType,
        event: eventPayload(localizeRuntimeEvent(event.event)),
      }
    case AGENT_EVENT_TYPES.STATUS: {
      const localized = localizedStatus(event)
      const payload: Record<string, AgentJsonValue> = { content: localized.content }
      if (localized.code !== undefined) payload['code'] = localized.code
      if (localized.attempt !== undefined && localized.attempt !== 0) {
        payload['attempt'] = localized.attempt
      }
      if (localized.maxAttempts !== undefined && localized.maxAttempts !== 0) {
        payload['max_attempts'] = localized.maxAttempts
      }
      return payload
    }
    case AGENT_EVENT_TYPES.COMPACTION:
    case AGENT_EVENT_TYPES.REASON:
    case AGENT_EVENT_TYPES.TOKEN:
    case AGENT_EVENT_TYPES.TOOL_RESULT:
    case AGENT_EVENT_TYPES.TOOL_START:
      return serializeAgentRuntimeEvent(event)
  }
}

function localizedStatus(event: AgentStatusEvent | LocalizedStatusEvent): LocalizedStatusEvent {
  const attempt = event.attempt ?? 0
  const maxAttempts = event.maxAttempts ?? 0
  let content = '处理中...'
  switch (event.code) {
    case AGENT_STATUS_CODES.THINKING:
      content = '思考中...'
      break
    case AGENT_STATUS_CODES.ANALYZING_RESULTS:
      content = '正在分析结果...'
      break
    // 这里减 1 是为了把运行时口径换算成用户口径：runtime 的 attempt/maxAttempts 把首次尝试也算在内，
    // 而用户看到的「第 N 次重试」不含首次。两侧都取 max(…, 1) 兜底，避免出现「第 0 次」。
    case AGENT_STATUS_CODES.LLM_RETRY:
      content = `LLM 请求失败，正在进行第 ${String(Math.max(attempt - 1, 1))}/${String(Math.max(maxAttempts - 1, 1))} 次重试...`
      break
    case AGENT_STATUS_CODES.LLM_EMPTY_RESPONSE_RETRY:
      content = `LLM 返回空响应，正在重试 (${String(attempt)}/${String(maxAttempts)})...`
      break
    case undefined:
      break
  }
  return {
    type: AGENT_EVENT_TYPES.STATUS,
    ...optionalField('code', event.code),
    ...optionalField('attempt', event.attempt),
    ...optionalField('maxAttempts', event.maxAttempts),
    content,
  }
}

function serializeAgentRuntimeEvent(
  event: Exclude<AgentRuntimeEvent, AgentStatusEvent>
): AgentJsonObject {
  switch (event.type) {
    case AGENT_EVENT_TYPES.TOKEN:
      return { content: event.content }
    case AGENT_EVENT_TYPES.TOOL_START:
      return { tool_name: event.toolName, call_id: event.callId, params: event.params }
    case AGENT_EVENT_TYPES.TOOL_RESULT:
      return {
        tool_name: event.toolName,
        call_id: event.callId,
        content: event.content,
        ...(event.error === undefined || event.error === '' ? {} : { error: event.error }),
      }
    case AGENT_EVENT_TYPES.REASON:
      return { content: event.content, step: event.step, timestamp: event.timestamp }
    case AGENT_EVENT_TYPES.COMPACTION:
      return {
        trigger: event.trigger,
        pre_tokens: event.preTokens,
        post_tokens: event.postTokens,
        messages_summarized: event.messagesSummarized,
      }
  }
}
