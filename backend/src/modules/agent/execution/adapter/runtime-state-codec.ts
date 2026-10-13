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
  /**
   * 将追加的消息并入状态信封：无既有状态时造一个最小 Checkpoint，有则按消息键去重后合并，
   * 避免恢复增量与主快照尾部重叠造成重复消息。
   * @param state 既有运行时状态信封；undefined 表示本次运行尚无快照
   * @param messages 待追加的产品消息；为空数组时原样返回 state（不产生无谓的重新序列化）
   * @returns 追加后的新状态信封；无消息可加时返回原 state
   */
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
 * @param state 业务侧状态信封（引擎名 + 版本 + 不透明 payload）
 * @returns 校验通过后解析出的 qing-tuan Checkpoint
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
 * @param state 既有状态信封；undefined 表示本次运行尚无快照，此时造一个最小 Checkpoint
 * @param messages 待追加的产品消息；为空数组时直接返回原 state，不做无谓的重新序列化
 * @returns 追加后的新信封；无可追加消息时原样返回入参
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

/**
 * 按完整消息键求最大重叠后缀后拼接，消除恢复增量与主快照尾部的重复消息。
 * @param base 已有快照中的消息序列
 * @param suffix 待并入的增量消息序列
 * @returns 去重拼接后的新数组；无重叠时等价于 base 直接接上 suffix
 */
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

/**
 * 判定两条消息是否等价，供去重时比较重叠后缀。
 * @param left 左侧消息；undefined 视为不相等，用于索引越界时的防御
 * @param right 右侧消息
 * @returns 两侧都存在且 JSON 序列化一致时为 true
 */
function sameMessage(left: AgentMessage | undefined, right: AgentMessage): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}
