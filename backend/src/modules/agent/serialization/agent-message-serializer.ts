import type { AgentJsonObject } from '../model/json-value.js'
import type { AgentMessage } from '../model/agent-message.js'

/**
 * 将产品消息转换为稳定的持久化 JSON；不依赖 Runtime SDK serializer。
 * @param message 产品消息；空的 toolCalls / toolCallId / name 按规则省略键，保证与存量记录一致
 * @returns 可直接落库的 JSON 对象（tool_calls 等键名沿用 snake_case）
 */
export function serializeAgentMessage(message: AgentMessage): AgentJsonObject {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls === undefined || message.toolCalls.length === 0
      ? {}
      : {
          tool_calls: message.toolCalls.map((call): AgentJsonObject => ({
            ...(call.index === undefined || call.index === 0 ? {} : { index: call.index }),
            id: call.id,
            type: call.type,
            function: { name: call.function.name, arguments: call.function.arguments },
          })),
        }),
    ...(message.toolCallId === undefined || message.toolCallId === ''
      ? {}
      : { tool_call_id: message.toolCallId }),
    ...(message.name === undefined || message.name === '' ? {} : { name: message.name }),
  }
}
