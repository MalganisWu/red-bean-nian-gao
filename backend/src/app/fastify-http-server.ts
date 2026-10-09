import type { FastifyInstance } from 'fastify'

import type { HttpServer } from './server-application.js'

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
    this.#server.addHook('onClose', (): Promise<void> => {
      this.#closed.resolve()
      return Promise.resolve()
    })
  }

  public async listen(): Promise<void> {
    if (this.#started) throw new Error('HTTP server is already started')
    this.#started = true
    await this.#server.listen({ host: this.#host, port: this.#port })
    await this.#closed.promise
  }

  public async shutdown(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await raceWithAbort(this.#gracefulClose(), signal)
  }

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
  return new Promise<void>((resolve, reject): void => {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (cause: unknown): void => {
        signal.removeEventListener('abort', onAbort)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    )
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('HTTP shutdown aborted')
}

function deferred(): Deferred {
  let resolve = (): void => {
    throw new Error('deferred promise resolved before initialization')
  }
  const promise = new Promise<void>((resolvePromise): void => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
