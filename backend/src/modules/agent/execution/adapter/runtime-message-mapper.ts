import type { RawMessage } from 'red-bean-qing-tuan/pipeline'

import type { AgentMessage, AgentToolCall } from '../../model/agent-message.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

/**
 * Runtime Adapter 的入站映射：产品消息转换为 SDK 消息，不共享可变数组引用。
 * @param message 产品域消息；toolCalls 逐条重建，入参数组与返回值不共享引用
 * @returns 新建的 SDK 消息；SDK 形状只允许在本 Adapter 层出现
 */
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

/**
 * Runtime Adapter 的出站映射：SDK 消息转换为产品消息。
 * @param message SDK 消息；toolCalls 逐条新建，出站结果不与 SDK 侧共享引用
 * @returns 新建的产品域消息
 */
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

/**
 * 批量入站映射；Adapter 之外不允许直接构造 `RawMessage`，SDK 形状只在这一层出现。
 * @param messages 产品域消息序列；逐条经 toRuntimeMessage 新建，输入数组不被改写
 * @returns 全新的 SDK 消息数组，与入参不共享元素引用
 */
export function toRuntimeMessages(messages: readonly AgentMessage[]): RawMessage[] {
  return messages.map(toRuntimeMessage)
}

/**
 * 批量出站映射；SDK 消息进入产品域的唯一入口，同样是逐条新建对象。
 * @param messages SDK 消息序列；逐条经 fromRuntimeMessage 新建，输入数组不被改写
 * @returns 全新的产品域消息数组，与 SDK 侧不共享元素引用
 */
export function fromRuntimeMessages(messages: readonly RawMessage[]): AgentMessage[] {
  return messages.map(fromRuntimeMessage)
}

/**
 * 单条工具调用入站映射：把产品域 call 转成 SDK 形状，逐字段重建，结果不与入参共享引用。
 * @param call 产品域工具调用
 * @returns SDK 侧的工具调用对象
 */
function toRuntimeToolCall(call: AgentToolCall): NonNullable<RawMessage['toolCalls']>[number] {
  return {
    ...optionalField('index', call.index),
    id: call.id,
    type: call.type,
    function: { name: call.function.name, arguments: call.function.arguments },
  }
}

/**
 * 单条工具调用出站映射：把 SDK 形状转回产品域 call，逐字段重建，结果不与 SDK 侧共享引用。
 * @param call SDK 侧工具调用对象
 * @returns 产品域工具调用
 */
function fromRuntimeToolCall(call: NonNullable<RawMessage['toolCalls']>[number]): AgentToolCall {
  return {
    ...optionalField('index', call.index),
    id: call.id,
    type: call.type,
    function: { name: call.function.name, arguments: call.function.arguments },
  }
}
