import { API_ROUTES } from '@red-bean/api-contract'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import { useAuthStore } from '@/stores/auth-store'
import { isWireSSEEventType, SSE_EVENT_TYPES } from '@/types/events'
import type { ParsedSSEEvent } from '@/types/events'
import type { ChatRequest, AnswerRequest } from '@/types/chat'

export interface SSEConnectionOptions {
  /** 目标端点，默认 API_ROUTES.CHAT.path；answer 用 API_ROUTES.CHAT_ANSWER.path */
  url?: string | undefined
  request: ChatRequest | AnswerRequest
  onEvent: (event: ParsedSSEEvent) => void
  onError: (error: Error) => void
  onClose: () => void
}

/** 连接打开后等待首个事件（START）的最长时间：半开连接不再无限挂起，转为可感知的连接错误。 */
const FIRST_EVENT_TIMEOUT_MS = 30_000

async function readJson(response: Response): Promise<unknown> {
  const source = await response.text()
  if (!source) return null
  return JSON.parse(source)
}

/** POST-based SSE 连接管理器（支持 Bearer Header） */
export function connectSSE(options: SSEConnectionOptions): AbortController {
  const ctrl = new AbortController()
  const token = useAuthStore.getState().token

  // 首事件看门狗：从调用起覆盖 fetch 建连与 onopen 后等待首帧两个阶段；
  // 若迟迟收不到任何事件（连接半开、代理吞帧），按连接失败处理并中止，
  // 避免前端 isStreaming/awaiting 永久悬挂。
  let firstEventTimer: number | undefined
  const clearFirstEventTimer = (): void => {
    if (firstEventTimer === undefined) return
    window.clearTimeout(firstEventTimer)
    firstEventTimer = undefined
  }
  firstEventTimer = window.setTimeout((): void => {
    firstEventTimer = undefined
    options.onError(new Error('连接超时：服务端长时间未响应，请重试。'))
    ctrl.abort()
  }, FIRST_EVENT_TIMEOUT_MS)

  void fetchEventSource(options.url ?? API_ROUTES.CHAT.path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(options.request),
    signal: ctrl.signal,

    onopen: async (response) => {
      if (response.ok) {
        // HTTP 头已到：首个事件仍由看门狗覆盖（onopen 不等同于事件流可用）
        return
      }
      // 非 2xx：优先解析 body 里的业务 message（如 409「交互不存在或已处理」），
      // 解析失败回退到状态码文案（中文 + 状态码，错误横幅直接展示）。
      let message = `连接失败（HTTP ${response.status}），请重试`
      try {
        const body = await readJson(response)
        if (
          typeof body === 'object' &&
          body !== null &&
          'message' in body &&
          typeof body.message === 'string' &&
          body.message
        ) {
          message = body.message
        }
      } catch {
        // body 不是 JSON 或不可读，用状态码文案兜底
      }
      clearFirstEventTimer()
      options.onError(new Error(message))
      ctrl.abort()
    },

    onmessage(msg) {
      // Microsoft fetch-event-source 已解析 event:/data: 行
      const eventType = msg.event || 'message'
      if (!isWireSSEEventType(eventType)) return
      const rawData: unknown = msg.data ? JSON.parse(msg.data) : null

      // 首个事件到达即证明连接可用：解除看门狗
      clearFirstEventTimer()

      // 心跳和注释忽略
      if (eventType === SSE_EVENT_TYPES.HEARTBEAT) return

      // agent_event 信封不在此拆包——useChatStream 需要完整信封（agent_name/event_type）
      options.onEvent({ eventType, data: rawData })
    },

    onerror(err) {
      clearFirstEventTimer()
      options.onError(err instanceof Error ? err : new Error(String(err)))
      // fetchEventSource 默认会重连，但 chat 是一次性流，不重连
      throw err // 抛出异常让 fetchEventSource 停止重连
    },

    onclose() {
      clearFirstEventTimer()
      options.onClose()
    },
  }).catch(() => undefined)

  return ctrl
}
