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
  const heartbeat = new Promise<NextOrHeartbeat>((resolve): void => {
    timer = setTimeout(
      (): void => resolve({ kind: STREAM_STEP_KINDS.HEARTBEAT }),
      heartbeatMilliseconds
    )
  })
  try {
    const disconnected = new Promise<NextOrHeartbeat>((resolve): void => {
      if (disconnectSignal.aborted) {
        resolve({ kind: STREAM_STEP_KINDS.DISCONNECTED })
        return
      }
      onDisconnect = (): void => resolve({ kind: STREAM_STEP_KINDS.DISCONNECTED })
      disconnectSignal.addEventListener('abort', onDisconnect, { once: true })
    })
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
