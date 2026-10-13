import type { RuntimeEvent } from 'red-bean-qing-tuan/pipeline'

import type { AgentRuntimeEvent } from '../../run/model/agent-runtime-event.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

/**
 * 把 SDK 事件复制为产品事件，避免 Runtime DTO 穿过执行 Adapter。
 * @param event SDK 侧的运行时事件；逐字段复制到产品事件，返回值不共享 SDK 引用
 * @returns 产品域的中性运行时事件
 */
export function fromRuntimeEvent(event: RuntimeEvent): AgentRuntimeEvent {
  switch (event.type) {
    case 'token':
      return { type: event.type, content: event.content }
    case 'status':
      return {
        type: event.type,
        ...optionalField('code', event.code),
        ...optionalField('attempt', event.attempt),
        ...optionalField('maxAttempts', event.maxAttempts),
      }
    case 'tool_start':
      return {
        type: event.type,
        toolName: event.toolName,
        callId: event.callId,
        params: event.params,
      }
    case 'tool_result':
      return {
        type: event.type,
        toolName: event.toolName,
        callId: event.callId,
        content: event.content,
        ...optionalField('error', event.error),
      }
    case 'reason':
      return {
        type: event.type,
        content: event.content,
        step: event.step,
        timestamp: event.timestamp,
      }
    case 'compaction':
      return {
        type: event.type,
        trigger: event.trigger,
        preTokens: event.preTokens,
        postTokens: event.postTokens,
        messagesSummarized: event.messagesSummarized,
      }
  }
}
