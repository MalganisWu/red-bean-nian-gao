import {
  STREAM_EVENT_TYPES,
  type ProductStreamEvent,
  type StartEvent,
} from '../../run/model/agent-run.js'
import { AGENT_EVENT_TYPES } from '../../run/model/agent-runtime-event.js'
import type { ChatRunHandle } from '../stream/chat-run-handle.js'
import { serializeSseEvent, toStreamErrorEvent } from './chat-event-presenter.js'

/** nextOrHeartbeat 步进结果的可辨识联合 kind；成员引用保证导航与防拼写漂移。 */
const STREAM_STEP_KINDS = Object.freeze({
  EVENT: 'event',
  HEARTBEAT: 'heartbeat',
  DISCONNECTED: 'disconnected',
} as const)

/**
 * 将领域事件转换为 SSE 帧，并在流结束时释放取消注册。
 *
 * 三处设计要点：
 * - **推理块合并**：相邻且 `step` 相同的 reason 事件攒成一条帧再发。
 *   模型一次推理会被切成几十个碎块，逐块发帧会让前端每秒处理上百条消息；
 *   按 step 合并既压低了帧数，又不会把不同推理轮次混在一起。
 * - **心跳**：模型长时间不吐字时靠它维持连接（网关通常会掐掉静默连接）。
 * - **收尾归属**：`finally` 里按「断连信号是否已触发」区分 `client_disconnected` 与 `consumer_closed`，
 *   这个区别会进终态记录，用于分辨「用户关掉了页面」和「服务端主动结束」。
 *
 * 事件序列契约：首帧恒为 `start`；随后按上游事件顺序发帧，相邻且同 `step` 的 reason 帧在此合并；
 * 模型静默超过 `heartbeatMilliseconds` 时插入心跳帧，仅用于保活、不代表业务进展；
 * 上游迭代结束后不再补帧。断连与收尾由 `finally` 承担——先归还上游迭代器，再无条件关闭句柄。
 *
 * @param handle - 运行句柄，提供事件迭代器与收尾用的 `close`；帧流结束时由本函数负责关闭。
 * @param start - 首帧 `start` 事件，携带 requestId/sessionId/traceId，让前端先拿到运行标识。
 * @param disconnectSignal - 客户端断连信号；一旦触发即停止发帧，并按 `client_disconnected` 收尾。
 * @param heartbeatMilliseconds - 静默多少毫秒后补一帧心跳；取值应小于网关的空闲连接超时。
 * @param now - 心跳时间戳的取时函数，默认 `Date.now`，测试可注入固定时钟。
 * @returns 逐帧 SSE 文本的异步生成器；顺序为 start → 事件（含合并后的 reason 与心跳）→ 终态。
 */
export async function* streamFrames(
  handle: ChatRunHandle,
  start: StartEvent,
  disconnectSignal: AbortSignal,
  heartbeatMilliseconds = 15_000,
  now: () => number = Date.now
): AsyncGenerator<string> {
  yield serializeSseEvent(start)
  const iterator = handle.events[Symbol.asyncIterator]()
  // 攒着未发出的推理块；遇到非同 step 的事件或流结束才 flush。
  let pendingReason: Extract<ProductStreamEvent, { readonly type: 'reason' }> | undefined
  let next = iterator.next()
  try {
    while (true) {
      const result = await nextOrHeartbeat(next, heartbeatMilliseconds, disconnectSignal)
      if (result.kind === STREAM_STEP_KINDS.DISCONNECTED) return
      if (result.kind === STREAM_STEP_KINDS.HEARTBEAT) {
        yield serializeSseEvent({ type: STREAM_EVENT_TYPES.HEARTBEAT, timestamp: now() })
        continue
      }
      if (result.iteration.done === true) {
        if (pendingReason !== undefined) yield serializeSseEvent(pendingReason)
        return
      }
      const event = result.iteration.value
      next = iterator.next()
      if (event.type === AGENT_EVENT_TYPES.REASON) {
        if (pendingReason !== undefined && pendingReason.step === event.step) {
          pendingReason = { ...pendingReason, content: pendingReason.content + event.content }
        } else {
          if (pendingReason !== undefined) yield serializeSseEvent(pendingReason)
          pendingReason = event
        }
        continue
      }
      if (pendingReason !== undefined) {
        yield serializeSseEvent(pendingReason)
        pendingReason = undefined
      }
      yield serializeSseEvent(event)
    }
  } catch (cause: unknown) {
    // 出错前先把攒着的推理块发出去，否则用户会看到推理内容凭空少了一段。
    if (pendingReason !== undefined) yield serializeSseEvent(pendingReason)
    yield serializeSseEvent(toStreamErrorEvent(cause))
  } finally {
    // 关闭上游迭代器（生产者可能还挂着），再关句柄——句柄的 close 会等运行真正收尾。
    await iterator.return?.()
    await handle.close(disconnectSignal.aborted ? 'client_disconnected' : 'consumer_closed')
  }
}

type NextOrHeartbeat =
  | { readonly kind: 'event'; readonly iteration: IteratorResult<ProductStreamEvent> }
  | { readonly kind: 'heartbeat' }
  | { readonly kind: 'disconnected' }

async function nextOrHeartbeat(
  next: Promise<IteratorResult<ProductStreamEvent>>,
  heartbeatMilliseconds: number,
  disconnectSignal: AbortSignal
): Promise<NextOrHeartbeat> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onDisconnect: (() => void) | undefined

  /** 心跳路径：部署定时器，到点即以心跳步进结果兑现；句柄交给外层 `finally` 清理。 */
  function armHeartbeat(resolve: (result: NextOrHeartbeat) => void): void {
    timer = setTimeout(
      (): void => resolve({ kind: STREAM_STEP_KINDS.HEARTBEAT }),
      heartbeatMilliseconds
    )
  }

  /** 断连路径：已中止则立即兑现，否则挂一次性监听，同样由外层 `finally` 摘除。 */
  function watchDisconnect(resolve: (result: NextOrHeartbeat) => void): void {
    if (disconnectSignal.aborted) {
      resolve({ kind: STREAM_STEP_KINDS.DISCONNECTED })
      return
    }
    onDisconnect = (): void => resolve({ kind: STREAM_STEP_KINDS.DISCONNECTED })
    disconnectSignal.addEventListener('abort', onDisconnect, { once: true })
  }

  const heartbeat = new Promise<NextOrHeartbeat>(armHeartbeat)
  try {
    const disconnected = new Promise<NextOrHeartbeat>(watchDisconnect)
    return await Promise.race([
      next.then((iteration): NextOrHeartbeat => ({ kind: STREAM_STEP_KINDS.EVENT, iteration })),
      heartbeat,
      disconnected,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onDisconnect !== undefined) disconnectSignal.removeEventListener('abort', onDisconnect)
  }
}
