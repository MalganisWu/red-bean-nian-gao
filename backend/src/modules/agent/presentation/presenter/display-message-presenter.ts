import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'
import type { DisplayMessage, MessageMeta } from '../model/display-message.js'

/**
 * 将 Agent 展示模型按稳定字段规则投影为可持久化 JSON；函数无状态且不持有外部资源。
 * @param message 产品展示消息；空 content / 空 source 与空 cards 等可选字段按规则省略，保证投影稳定
 * @returns 可直接落库的 JSON 对象（键名沿用 snake_case）
 */
export function serializeDisplayMessage(message: DisplayMessage): AgentJsonObject {
  const payload: Record<string, AgentJsonValue> = { role: message.role }
  if (message.content !== undefined) payload['content'] = message.content
  if (message.cards !== undefined && message.cards.length > 0) {
    payload['cards'] = message.cards.map((card): AgentJsonObject => ({
      type: card.type,
      data: card.data,
    }))
  }
  if (message.sections !== undefined) payload['sections'] = message.sections
  if (message.source !== undefined && message.source !== '') payload['source'] = message.source
  if (message.meta !== undefined) payload['meta'] = serializeMessageMeta(message.meta)
  payload['timestamp'] = message.timestamp
  return payload
}

function serializeMessageMeta(meta: MessageMeta): AgentJsonObject {
  const payload: Record<string, AgentJsonValue> = {}
  if (meta.scheduledTask !== undefined) {
    payload['scheduled_task'] = {
      task_id: meta.scheduledTask.taskId,
      task_name: meta.scheduledTask.taskName,
      status: meta.scheduledTask.status,
      execution_id: meta.scheduledTask.executionId,
      scheduled_at: meta.scheduledTask.scheduledAt,
      completed_at: meta.scheduledTask.completedAt,
    }
  }
  if (meta.runStartedAt !== undefined && meta.runStartedAt !== 0) {
    payload['run_started_at'] = meta.runStartedAt
  }
  return payload
}
