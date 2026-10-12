import type { RawMessage } from 'red-bean-qing-tuan/pipeline'

import type { AgentMessage, AgentToolCall } from '../../model/agent-message.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

/** Runtime Adapter 的入站映射：产品消息转换为 SDK 消息，不共享可变数组引用。 */
export function toRuntimeMessage(message: AgentMessage): RawMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls === undefined
      ? {}
      : { toolCalls: message.toolCalls.map(toRuntimeToolCall) }),
    ...optionalField('toolCallId', message.toolCallId),
    ...optionalField('name', message.name),
  }
}

/** Runtime Adapter 的出站映射：SDK 消息转换为产品消息。 */
export function fromRuntimeMessage(message: RawMessage): AgentMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls === undefined
      ? {}
      : { toolCalls: message.toolCalls.map(fromRuntimeToolCall) }),
    ...optionalField('toolCallId', message.toolCallId),
    ...optionalField('name', message.name),
  }
}

/** 批量入站映射；Adapter 之外不允许直接构造 `RawMessage`，SDK 形状只在这一层出现。 */
export function toRuntimeMessages(messages: readonly AgentMessage[]): RawMessage[] {
  return messages.map(toRuntimeMessage)
}

/** 批量出站映射；SDK 消息进入产品域的唯一入口，同样是逐条新建对象。 */
export function fromRuntimeMessages(messages: readonly RawMessage[]): AgentMessage[] {
  return messages.map(fromRuntimeMessage)
}

function toRuntimeToolCall(call: AgentToolCall): NonNullable<RawMessage['toolCalls']>[number] {
  return {
    ...optionalField('index', call.index),
    id: call.id,
    type: call.type,
    function: { name: call.function.name, arguments: call.function.arguments },
  }
}

function fromRuntimeToolCall(call: NonNullable<RawMessage['toolCalls']>[number]): AgentToolCall {
  return {
    ...optionalField('index', call.index),
    id: call.id,
    type: call.type,
    function: { name: call.function.name, arguments: call.function.arguments },
  }
}
