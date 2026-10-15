import { Lifecycle } from './lifecycle.js'
import type { HealthServicePort } from '../modules/system/public-api.js'
import type { BackgroundTask } from '../shared/lifecycle/background-task.js'
import { normalizeError } from '../shared/errors/normalize-error.js'

export type { BackgroundTask } from '../shared/lifecycle/background-task.js'

/** HTTP 服务的生命周期端口；`shutdown` 是停止接收新连接并排空，`close` 是强制收尾。 */
export interface HttpServer {
  /** 启动服务并驻留到关闭为止；服务自身退出也应在此 Promise 上被观察到。 */
  listen(): Promise<void>
  /**
   * 优雅停止：在信号预算内停止接收新连接并排空存量请求。
   * @param signal - 关闭的时间预算；到点即中止，由调用方决定是否转强制关闭
   */
  shutdown(signal: AbortSignal): Promise<void>
  /** 强制收尾：不等待存量请求排空，直接释放连接与资源。 */
  close(): Promise<void>
}

/** 排空期要跑的一项任务（关队列消费者、等租约释放等）；与 HTTP 排空并行执行。 */
export type ShutdownTask = (signal: AbortSignal) => Promise<void>

/** 组装选项；后台任务与排空任务分开配置，因为二者的收束时机不同（见 `run` 的注释）。 */
export interface ServerApplicationOptions {
  /** HTTP 服务实现，承担监听与关闭语义。 */
  readonly server: HttpServer
  /** 受管生命周期对象，用于在收尾阶段释放已登记资源。 */
  readonly lifecycle: Lifecycle
  /** 可选的就绪状态端口；提供后会在排空前置为 draining，让探针先摘流量。 */
  readonly health?: Pick<HealthServicePort, 'setDraining'>
  /** 与 HTTP 一起驻留的后台任务；收束发生在 `finally`，不随中止信号立刻停。 */
  readonly backgroundTasks?: readonly BackgroundTask[]
  /** 排空期并行执行的任务，用于关队列消费者、等租约释放等。 */
  readonly shutdownTasks?: readonly ShutdownTask[]
  /** 优雅排空的时间预算；非有限正数时退回默认值，超时后转强制关闭。 */
  readonly shutdownTimeoutMilliseconds?: number
  /** 强制收尾的时间预算；非有限正数时退回默认值，用于关停生命周期的残留资源。 */
  readonly closeTimeoutMilliseconds?: number
}

/** 服务监听一相的结局：成功时无字段，失败时携带归一化错误。 */
interface ServerOutcome {
  /** 监听失败时的错误；成功结束时为 `undefined`。 */
  readonly error?: Error
}

/** 中止等待句柄：一个可等待的 Promise 加一个解绑函数。 */
interface AbortWait {
  /** 信号中止时兑现的 Promise。 */
  readonly promise: Promise<void>
  /** 解绑信号监听器，避免往长生命周期的信号上累积监听。 */
  dispose(): void
}

/** 默认优雅关停预算（毫秒）：30 秒给负载均衡摘流量与存量请求收尾留出余量。 */
const DEFAULT_SHUTDOWN_TIMEOUT_MILLISECONDS = 30_000
/** 默认强制关停预算（毫秒）：10 秒做强制收尾，再长只会拖慢进程退出。 */
const DEFAULT_CLOSE_TIMEOUT_MILLISECONDS = 10_000

/** 统一管理服务、后台任务、排空状态和资源释放。 */
export class ServerApplication {
  /** HTTP 服务实现，承担监听与关闭语义。 */
  readonly #server: HttpServer
  /** 受管生命周期对象，收尾阶段由它释放已登记资源。 */
  readonly #lifecycle: Lifecycle
  /** 可选的就绪状态端口；存在时在排空前置为 draining。 */
  readonly #health: Pick<HealthServicePort, 'setDraining'> | undefined
  /** 与 HTTP 一起驻留的后台任务，在 `finally` 中统一收束。 */
  readonly #backgroundTasks: readonly BackgroundTask[]
  /** 排空期并行执行的任务集合。 */
  readonly #shutdownTasks: readonly ShutdownTask[]
  /** 已归一化的优雅排空预算（毫秒），保证为有限正数。 */
  readonly #shutdownTimeoutMilliseconds: number
  /** 已归一化的强制收尾预算（毫秒），保证为有限正数。 */
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
   * @param signal - 外部中止信号，通常来自进程收到的 SIGINT/SIGTERM；它是进入关闭流程的唯一触发器
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
        // 关闭期在超时预算内并行执行的排空动作。
        const drainWithinTimeout = async (timeoutSignal: AbortSignal): Promise<void> => {
          // HTTP 停止接收新连接与业务运行排空必须并行，避免长连接互相等待。
          await Promise.all([
            this.#server.shutdown(timeoutSignal),
            ...this.#shutdownTasks.map((task): Promise<void> =>
              Promise.resolve().then(() => task(timeoutSignal))
            ),
          ])
        }
        try {
          await withTimeout(
            drainWithinTimeout,
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
 * @param build - 构建回调，收到本次生命周期对象用于登记关闭责任；其返回值原样透传
 * @param closeTimeoutMilliseconds - 失败清理的时间预算；非有限正数时退回默认值
 * @returns 构建回调的返回值，仅在构建成功时给出
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

/**
 * 把可能失败的操作收敛成一个描述结局的对象。
 * 用「成败都 resolve」代替直接 await，是为了让 `Promise.race` 能区分
 * 「服务自己退出」与「收到中止信号」两条路径，而不把异常当作控制流抛出。
 * @param operation - 要观察的服务监听操作
 * @returns 成功时无 `error`，失败时携带归一化后的错误
 */
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
 * @param signal - 要等待中止的信号；已中止的信号直接返回已兑现的 Promise
 * @returns 可等待的 Promise 与解绑函数
 */
function waitForAbort(signal: AbortSignal): AbortWait {
  if (signal.aborted) {
    return { promise: Promise.resolve(), dispose(): void {} }
  }
  let listener = (): void => {}
  // executor：把 resolve 交给 abort 监听器，交给调用方按需 `dispose`。
  const promise = new Promise<void>(function captureAbortResolve(resolve): void {
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

/**
 * 给操作套一个超时上限：到点即中止并拒绝，操作正常落定时清理定时器。
 * 超时通过中止信号传给操作，让操作有机会自行收尾，而不是只让上层失去等待。
 * @param operation - 接收中止信号的操作；超时时其信号被中止
 * @param milliseconds - 超时的毫秒数
 * @param message - 超时错误的文案，便于区分是哪个阶段超时
 */
async function withTimeout(
  operation: (signal: AbortSignal) => Promise<void>,
  milliseconds: number,
  message: string
): Promise<void> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  // executor：到点后中止 controller 并以超时错误拒绝，`timeout` 句柄由调用方在 finally 里清理。
  const expired = new Promise<never>(function awaitTimeout(_resolve, reject): void {
    // 到点：中止 controller 并以超时错误拒绝。
    function expireAfterTimeout(): void {
      const error = new Error(message)
      controller.abort(error)
      reject(error)
    }
    timeout = setTimeout(expireAfterTimeout, milliseconds)
  })
  try {
    await Promise.race([operation(controller.signal), expired])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

/**
 * 取有限正数，否则退回默认值。
 * 非法超时（`NaN`、无穷、零或负数）在此被视为「未配置」而不是抛错：超时预算是可选调优项，
 * 缺失时用默认值比让进程起不来更合理；这与端口校验的「非法即抛错」是有意的区别。
 * @param value - 调用方传入的超时值
 * @param fallback - 非法或缺失时使用的默认值
 * @returns 一个有限正数超时
 */
function positiveTimeout(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value
}
