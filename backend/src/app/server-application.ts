import { Lifecycle } from './lifecycle.js'
import type { HealthServicePort } from '../modules/system/public-api.js'
import type { BackgroundTask } from '../shared/lifecycle/background-task.js'
import { normalizeError } from '../shared/errors/normalize-error.js'

export type { BackgroundTask } from '../shared/lifecycle/background-task.js'

/** HTTP 服务的生命周期端口；`shutdown` 是停止接收新连接并排空，`close` 是强制收尾。 */
export interface HttpServer {
  listen(): Promise<void>
  shutdown(signal: AbortSignal): Promise<void>
  close(): Promise<void>
}

/** 排空期要跑的一项任务（关队列消费者、等租约释放等）；与 HTTP 排空并行执行。 */
export type ShutdownTask = (signal: AbortSignal) => Promise<void>

/** 组装选项；后台任务与排空任务分开配置，因为二者的收束时机不同（见 `run` 的注释）。 */
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

  /**
   * 启动并驻留，直到服务自己退出或收到中止信号；退出前完成一次优雅关闭。
   *
   * 关闭顺序里三处是刻意的：
   * - **先 `setDraining(true)`** 再关服务：让 readiness 探针立即开始拒绝，
   *   负载均衡先把流量摘走，正在处理的请求才有机会跑完（顺序反了就是直接掐断）。
   * - **HTTP 停止接收与业务排空并行**：串行的话两者会互相等待，
   *   总时长等于两者之和，很容易撞上关闭超时。
   * - **超时后强制 `close()`**：优雅关闭失败不能变成关不掉，进程必须能退。
   *
   * 后台任务跑在独立的 controller 上，不随中止信号立刻停——它们在 `finally` 里被统一收束，
   * 因为中途丢弃它们会留下未提交的定时任务状态。
   * 所有阶段的错误都收集起来，最后聚合成一个 `AggregateError`：关闭期同时坏掉好几处是常态，
   * 只报第一个会让其余问题永远看不见。
   */
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

/**
 * 在受管生命周期内执行构建：构建中途失败时，把已经登记的资源关掉再抛。
 *
 * 这是「半启动进程」的防线——构建链走到第五步失败却留着前三步建好的连接池与后台定时器，
 * 会让进程既不能正常工作也不退出。关闭失败会与构建失败一起抛出，保住原始根因。
 */
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

/**
 * 把中止信号变成一个可等待的 Promise，并返回解绑函数。
 * 已经中止的信号直接返回已完成的 Promise：`addEventListener('abort')` 对已中止的信号不会再触发，
 * 不加这个短路就会永远等下去。
 * `dispose` 由调用方在 finally 中执行，避免往长生命周期的信号上累积监听器。
 */
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
