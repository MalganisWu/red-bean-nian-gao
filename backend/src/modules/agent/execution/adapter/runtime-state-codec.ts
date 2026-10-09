import { parseCheckpoint, serializeCheckpoint } from 'red-bean-qing-tuan'
import type { Checkpoint } from 'red-bean-qing-tuan'

import type { AgentMessage } from '../../model/agent-message.js'
import type { StoredRuntimeState } from '../model/runtime-state.js'
import type { RuntimeStateAppender } from '../port/runtime-state-appender.js'
import { fromRuntimeMessages, toRuntimeMessages } from './runtime-message-mapper.js'

/** SDK Checkpoint 的业务侧防腐适配器；业务 Service 只依赖 RuntimeStateAppender。 */
export class RuntimeStateCodec implements RuntimeStateAppender {
  public appendMessages(
    state: StoredRuntimeState | undefined,
    messages: readonly AgentMessage[]
  ): StoredRuntimeState | undefined {
    return appendRuntimeMessages(state, messages)
  }
}

/** 校验业务信封与 SDK payload 的引擎和版本一致性。 */
export function parseStoredRuntimeState(state: StoredRuntimeState): Checkpoint {
  if (state.engine !== 'qing-tuan') throw new Error('不支持的 Runtime 状态引擎')
  const checkpoint = parseCheckpoint(state.payload)
  if (checkpoint.version !== state.version) throw new Error('Runtime 状态版本不一致')
  return checkpoint
}

/**
 * 后端侧的 SDK 状态适配器。业务服务只传递状态信封，只有这一层理解
 * qing-tuan checkpoint 的内部结构。
 */
function appendRuntimeMessages(
  state: StoredRuntimeState | undefined,
  messages: readonly AgentMessage[]
): StoredRuntimeState | undefined {
  if (messages.length === 0) return state
  if (state === undefined) {
    const checkpoint = {
      version: 1,
      threadId: '',
      userId: '',
      status: 'completed' as const,
      messages: toRuntimeMessages(messages),
      contentRefs: [],
      lastResumeInterrupt: '',
      tokensUsed: 0,
      finishReason: '',
    }
    return { engine: 'qing-tuan', version: 1, payload: serializeCheckpoint(checkpoint) }
  }
  const checkpoint = parseStoredRuntimeState(state)
  const updated = {
    ...checkpoint,
    messages: toRuntimeMessages(
      appendWithoutOverlap(fromRuntimeMessages(checkpoint.messages), messages)
    ),
  }
  return {
    engine: 'qing-tuan',
    version: updated.version,
    payload: serializeCheckpoint(updated),
  }
}

function appendWithoutOverlap(
  base: readonly AgentMessage[],
  suffix: readonly AgentMessage[]
): AgentMessage[] {
  const maximum = Math.min(base.length, suffix.length)
  for (let size = maximum; size > 0; size -= 1) {
    const baseOffset = base.length - size
    const overlaps = suffix
      .slice(0, size)
      .every((message, index): boolean => sameMessage(base[baseOffset + index], message))
    if (overlaps) return [...base, ...suffix.slice(size)]
  }
  return [...base, ...suffix]
}

function sameMessage(left: AgentMessage | undefined, right: AgentMessage): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}
