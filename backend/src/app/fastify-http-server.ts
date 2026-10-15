import type { FastifyInstance } from 'fastify'

import type { HttpServer } from './server-application.js'

/** 监听参数；`port` 允许字符串是因为它直接来自配置层的字符串取值。 */
export interface FastifyHttpServerOptions {
  /** 绑定的主机地址；空串在构造期被拒绝，避免落到一个不可预期的监听地址。 */
  readonly host: string
  /** 监听端口；允许字符串是因为它直接来自配置层，构造期统一归一为整数。 */
  readonly port: string | number
}

/** 可从外部兑现的一次性 Promise 句柄，用于把「服务已关闭」变成一个可等待的事件。 */
interface Deferred {
  /** 等待端持有的 Promise，在 `resolve` 被调用前一直挂起。 */
  readonly promise: Promise<void>
  /** 触发兑现的函数，调用一次即解除 `promise` 的等待。 */
  readonly resolve: () => void
}

/** 将 Fastify 启动后立即返回的 API 适配为应用持续服务直至关闭的生命周期。 */
export class FastifyHttpServer implements HttpServer {
  /** 底层 Fastify 实例，负责实际监听、钩子与连接管理。 */
  readonly #server: FastifyInstance
  /** 已完成非空校验的监听主机地址。 */
  readonly #host: string
  /** 归一化后的监听端口，构造期已确认为合法整数。 */
  readonly #port: number
  /** 关闭信号：`onClose` 钩子兑现它，`listen` 在此驻留等待。 */
  readonly #closed = deferred()
  /** 是否已进入启动流程，用于拒绝重复的 `listen`。 */
  #started = false
  /** 幂等关闭的 Promise 缓存，并发关停时共享同一次底层 `close()`。 */
  #closePromise: Promise<void> | undefined

  public constructor(server: FastifyInstance, options: FastifyHttpServerOptions) {
    const port = numericPort(options.port)
    if (options.host.trim() === '') throw new Error('HTTP host 不能为空')
    this.#server = server
    this.#host = options.host
    this.#port = port
    // onClose 钩子：兑现 `#closed`，结束 `listen` 的驻留等待。
    const onServerClose = (): Promise<void> => {
      this.#closed.resolve()
      return Promise.resolve()
    }
    this.#server.addHook('onClose', onServerClose)
  }

  /**
   * 启动并**驻留到关闭为止**：先 `listen`，再等 `#closed` 兑现。
   *
   * 第二个 `await` 是让 `ServerApplication.run` 的 `Promise.race` 成立的关键——
   * Fastify 的 `listen()` 一旦开始服务就 resolve 了，若这里直接返回，
   * 「服务自己挂掉」就永远不会被观察到。等 `onClose` 钩子兑现，才等价于「一直服务到关闭」。
   */
  public async listen(): Promise<void> {
    if (this.#started) throw new Error('HTTP 服务已经启动')
    this.#started = true
    await this.#server.listen({ host: this.#host, port: this.#port })
    await this.#closed.promise
  }

  /**
   * 优雅关闭，且可被中止打断——超时后由 `ServerApplication` 改用 `close()` 强制收尾。
   * @param signal - 关闭的时间预算；到点即拒绝 Promise，让上层有机会走强制关闭
   */
  public async shutdown(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await raceWithAbort(this.#gracefulClose(), signal)
  }

  /**
   * 强制关闭：先掐掉所有连接再走优雅关闭。
   * 顺序是有意的——`server.close()` 只停止接受新连接并等待存量请求结束，
   * 不主动断开长连接（SSE 就是长连接）。不先 `closeAllConnections()` 的话，
   * 一个挂着的 SSE 会让关闭一直等下去。
   */
  public async close(): Promise<void> {
    this.#server.server.closeAllConnections()
    await this.#gracefulClose()
  }

  /**
   * 幂等的优雅关闭：首次调用发起底层 `server.close()`，后续调用复用同一个 Promise。
   * `#closePromise` 去重既避免并发关停重复关闭，也保证所有等待方拿到同一个结局——
   * 例如 `shutdown` 超时后上层再调 `close()`，此时两次调用共享同一次收尾。
   */
  #gracefulClose(): Promise<void> {
    this.#closePromise ??= this.#server.close().then((): void => {
      this.#closed.resolve()
    })
    return this.#closePromise
  }
}

/**
 * 把配置里的端口归一为合法整数；非法值直接抛错而不是降级到默认端口。
 * 端口是本进程唯一的对外监听入口，静默降级会让流量指向一个无人知晓的端口，
 * 排查成本远高于启动即失败；0 是合法值（由内核分配空闲端口）。
 * @param value - 原始端口值；数字原样使用，字符串按十进制解析
 * @returns 0 到 65535 之间的安全整数
 */
function numericPort(value: string | number): number {
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('HTTP 端口必须是 0 到 65535 之间的整数')
  }
  return port
}

/**
 * 让操作与中止信号竞速：先中止即拒绝，否则等操作落定。
 * 操作落定后会解绑 abort 监听，避免在长生命周期的信号上累积监听器。
 * @param operation - 要等待的操作；其成败原样传递
 * @param signal - 中止信号；已中止时立即拒绝而不等待操作
 */
function raceWithAbort(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  // 完成或中止竞速的 executor：abort 先到时拒绝，否则等 operation 落定后解绑监听。
  return new Promise<void>(function raceAgainstAbort(resolve, reject): void {
    const onAbort = (): void => reject(abortReason(signal))
    // 操作落定：解绑取消监听后兑现。
    function resolveAfterOperation(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    // 操作失败：解绑取消监听后以归一化错误拒绝。
    function rejectAfterOperation(cause: unknown): void {
      signal.removeEventListener('abort', onAbort)
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(resolveAfterOperation, rejectAfterOperation)
  })
}

/**
 * 从中止信号里取归一化的错误原因；信号未附带 Error 时退化为固定文案，
 * 保证调用方拿到的始终是可安全抛出、可读的错误对象。
 * @param signal - 被中止的信号
 * @returns 可直接抛出的 Error 实例
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('HTTP 关闭已中止')
}

/**
 * 构造一个可从外部兑现的 Promise。
 * 初始 `resolve` 故意实现为抛错而不是空函数：真出现「兑现早于初始化」的时序问题时，
 * 会在调用点直接炸掉，而不是变成一个静默失效的等待。
 * @returns 含挂起 Promise 与兑现函数的句柄
 */
function deferred(): Deferred {
  let resolve = (): void => {
    throw new Error('deferred promise 在初始化前就被兑现')
  }
  const promise = new Promise<void>((resolvePromise): void => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
