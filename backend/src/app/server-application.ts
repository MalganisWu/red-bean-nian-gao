import { Lifecycle } from './lifecycle.js'
import type { HealthServicePort } from '../modules/system/public-api.js'
import type { BackgroundTask } from '../shared/lifecycle/background-task.js'
import { normalizeError } from '../shared/errors/normalize-error.js'

export type { BackgroundTask } from '../shared/lifecycle/background-task.js'

export interface HttpServer {
  listen(): Promise<void>
  shutdown(signal: AbortSignal): Promise<void>
  close(): Promise<void>
}

export type ShutdownTask = (signal: AbortSignal) => Promise<void>

export interface ServerApplicationOptions {
  readonly server: HttpServer
  readonly lifecycle: Lifecycle
  readonly health?: Pick<HealthServicePort, 'setDraining'>
  readonly backgroundTasks?: readonly BackgroundTask[]
  readonly shutdownTasks?: readonly ShutdownTask[]
  readonly shutdownTimeoutMilliseconds?: number
  readonly closeTimeoutMilliseconds?: number
}

interface ServerOutcome {
  readonly error?: Error
}

interface AbortWait {
  readonly promise: Promise<void>
  dispose(): void
}

const DEFAULT_SHUTDOWN_TIMEOUT_MILLISECONDS = 30_000
const DEFAULT_CLOSE_TIMEOUT_MILLISECONDS = 10_000

/** 统一管理服务、后台任务、排空状态和资源释放。 */
export class ServerApplication {
  readonly #server: HttpServer
  readonly #lifecycle: Lifecycle
  readonly #health: Pick<HealthServicePort, 'setDraining'> | undefined
  readonly #backgroundTasks: readonly BackgroundTask[]
  readonly #shutdownTasks: readonly ShutdownTask[]
  readonly #shutdownTimeoutMilliseconds: number
  readonly #closeTimeoutMilliseconds: number

  public constructor(options: ServerApplicationOptions) {
    this.#server = options.server
    this.#lifecycle = options.lifecycle
    this.#health = options.health
    this.#backgroundTasks = options.backgroundTasks ?? []
    this.#shutdownTasks = options.shutdownTasks ?? []
    this.#shutdownTimeoutMilliseconds = positiveTimeout(
      options.shutdownTimeoutMilliseconds,
      DEFAULT_SHUTDOWN_TIMEOUT_MILLISECONDS
    )
    this.#closeTimeoutMilliseconds = positiveTimeout(
      options.closeTimeoutMilliseconds,
      DEFAULT_CLOSE_TIMEOUT_MILLISECONDS
    )
  }

  public async run(signal: AbortSignal): Promise<void> {
    const errors: Error[] = []
    const backgroundController = new AbortController()
    const backgroundRuns = this.#backgroundTasks.map((task): Promise<void> =>
      Promise.resolve().then((): Promise<void> => task(backgroundController.signal))
    )
    const abortWait = waitForAbort(signal)
    const serverOutcome = settle(this.#server.listen())

    try {
      const outcome = await Promise.race([
        serverOutcome.then((result): readonly ['server', ServerOutcome] => ['server', result]),
        abortWait.promise.then((): readonly ['abort', undefined] => ['abort', undefined]),
      ])

      if (outcome[0] === 'server') {
        if (outcome[1].error !== undefined) errors.push(outcome[1].error)
      } else {
        this.#health?.setDraining(true)
        try {
          await withTimeout(
            async (timeoutSignal): Promise<void> => {
              // HTTP 停止接收新连接与业务运行排空必须并行，避免长连接互相等待。
              await Promise.all([
                this.#server.shutdown(timeoutSignal),
                ...this.#shutdownTasks.map((task): Promise<void> =>
                  Promise.resolve().then(() => task(timeoutSignal))
                ),
              ])
            },
            this.#shutdownTimeoutMilliseconds,
            'HTTP server shutdown timed out'
          )
        } catch (error: unknown) {
          errors.push(normalizeError(error))
          try {
            await this.#server.close()
          } catch (closeError: unknown) {
            errors.push(normalizeError(closeError))
          }
        }
        const stopped = await serverOutcome
        if (stopped.error !== undefined) errors.push(stopped.error)
      }
    } finally {
      abortWait.dispose()
      backgroundController.abort()
      const backgroundResults = await Promise.allSettled(backgroundRuns)
      for (const result of backgroundResults) {
        if (result.status === 'rejected') errors.push(normalizeError(result.reason))
      }
      try {
        await this.#lifecycle.close(AbortSignal.timeout(this.#closeTimeoutMilliseconds))
      } catch (error: unknown) {
        errors.push(normalizeError(error))
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'run server application')
    }
  }
}

export async function buildManaged<T>(
  build: (lifecycle: Lifecycle) => T | Promise<T>,
  closeTimeoutMilliseconds = DEFAULT_CLOSE_TIMEOUT_MILLISECONDS
): Promise<T> {
  const lifecycle = new Lifecycle()
  try {
    return await build(lifecycle)
  } catch (buildError: unknown) {
    const errors: Error[] = [normalizeError(buildError)]
    try {
      await lifecycle.close(AbortSignal.timeout(closeTimeoutMilliseconds))
    } catch (closeError: unknown) {
      errors.push(normalizeError(closeError))
    }
    throw new AggregateError(errors, 'build application', { cause: buildError })
  }
}

function settle(operation: Promise<void>): Promise<ServerOutcome> {
  return operation.then(
    (): ServerOutcome => ({}),
    (error: unknown): ServerOutcome => ({ error: normalizeError(error) })
  )
}

function waitForAbort(signal: AbortSignal): AbortWait {
  if (signal.aborted) {
    return { promise: Promise.resolve(), dispose(): void {} }
  }
  let listener = (): void => {}
  const promise = new Promise<void>((resolve): void => {
    listener = resolve
    signal.addEventListener('abort', listener, { once: true })
  })
  return {
    promise,
    dispose(): void {
      signal.removeEventListener('abort', listener)
    },
  }
}

async function withTimeout(
  operation: (signal: AbortSignal) => Promise<void>,
  milliseconds: number,
  message: string
): Promise<void> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject): void => {
    timeout = setTimeout((): void => {
      const error = new Error(message)
      controller.abort(error)
      reject(error)
    }, milliseconds)
  })
  try {
    await Promise.race([operation(controller.signal), expired])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value
}
