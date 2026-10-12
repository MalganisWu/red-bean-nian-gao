import { parseCheckpoint, serializeCheckpoint } from 'red-bean-qing-tuan'
import type { Checkpoint } from 'red-bean-qing-tuan'

import type { AgentMessage } from '../../model/agent-message.js'
import type { StoredRuntimeState } from '../model/runtime-state.js'
import type { RuntimeStateAppender } from '../port/runtime-state-appender.js'
import { fromRuntimeMessages, toRuntimeMessages } from './runtime-message-mapper.js'

/**
 * SDK Checkpoint 的业务侧防腐适配器；业务 Service 只依赖 RuntimeStateAppender。
 *
 * 「防腐」体现在边界位置上：业务侧存的是 `StoredRuntimeState` 信封（引擎名 + 版本 + 不透明 payload），
 * 只有本文件知道 payload 里是 qing-tuan 的 Checkpoint 结构。
 * 因此 SDK 换版本、换实现甚至换引擎时，改动被限制在这一个文件里，
 * 数据库里也不需要为 SDK 的内部字段建列。
 */
export class RuntimeStateCodec implements RuntimeStateAppender {
  public appendMessages(
    state: StoredRuntimeState | undefined,
    messages: readonly AgentMessage[]
  ): StoredRuntimeState | undefined {
    return appendRuntimeMessages(state, messages)
  }
}

/**
 * 校验业务信封与 SDK payload 的引擎和版本一致性。
 *
 * 两道检查各挡一类问题：**引擎名**挡住「拿另一个 SDK 的状态来解析」；
 * **版本号**挡住「升级 SDK 后解析旧 payload」——后者最危险，
 * 因为结构相似时解析不会报错，只会悄悄产生语义错乱的状态。宁可拒绝加载。
 */
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
  // 没有既有状态时造一个最小 Checkpoint。threadId/userId 留空是刻意的：
  // 这个信封不携带身份（身份在 Session 记录上），填一个编造的 ID 反而会与真实身份冲突。
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
