import type { FastifyInstance } from 'fastify'

import type { HttpServer } from './server-application.js'

/** 监听参数；`port` 允许字符串是因为它直接来自配置层的字符串取值。 */
export interface FastifyHttpServerOptions {
  readonly host: string
  readonly port: string | number
}

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

/** 将 Fastify 启动后立即返回的 API 适配为应用持续服务直至关闭的生命周期。 */
export class FastifyHttpServer implements HttpServer {
  readonly #server: FastifyInstance
  readonly #host: string
  readonly #port: number
  readonly #closed = deferred()
  #started = false
  #closePromise: Promise<void> | undefined

  public constructor(server: FastifyInstance, options: FastifyHttpServerOptions) {
    const port = numericPort(options.port)
    if (options.host.trim() === '') throw new Error('HTTP host must not be empty')
    this.#server = server
    this.#host = options.host
    this.#port = port
    /** onClose 钩子：兑现 `#closed`，结束 `listen` 的驻留等待。 */
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
    if (this.#started) throw new Error('HTTP server is already started')
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

  #gracefulClose(): Promise<void> {
    this.#closePromise ??= this.#server.close().then((): void => {
      this.#closed.resolve()
    })
    return this.#closePromise
  }
}

function numericPort(value: string | number): number {
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('HTTP port must be an integer between 0 and 65535')
  }
  return port
}

function raceWithAbort(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  /** 完成或中止竞速的 executor：abort 先到时拒绝，否则等 operation 落定后解绑监听。 */
  return new Promise<void>(function raceAgainstAbort(resolve, reject): void {
    const onAbort = (): void => reject(abortReason(signal))
    /** 操作落定：解绑取消监听后兑现。 */
    function resolveAfterOperation(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    /** 操作失败：解绑取消监听后以归一化错误拒绝。 */
    function rejectAfterOperation(cause: unknown): void {
      signal.removeEventListener('abort', onAbort)
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(resolveAfterOperation, rejectAfterOperation)
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('HTTP shutdown aborted')
}

/**
 * 构造一个可从外部兑现的 Promise。
 * 初始 `resolve` 故意实现为抛错而不是空函数：真出现「兑现早于初始化」的时序问题时，
 * 会在调用点直接炸掉，而不是变成一个静默失效的等待。
 */
function deferred(): Deferred {
  let resolve = (): void => {
    throw new Error('deferred promise resolved before initialization')
  }
  const promise = new Promise<void>((resolvePromise): void => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
