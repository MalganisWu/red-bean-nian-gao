import type {
  HealthServicePort,
  ReadinessCheck,
  ReadinessChecks,
  ReadinessResult,
  VersionInfo,
} from './port/health-service.port.js'

/**
 * 未注入构建版本时的占位快照：全部字段取 `unknown`，让本地与测试环境也能回答 version 探针，
 * 而无需伪造一个看似真实的版本号。冻结避免调用方误改共享常量。
 */
const DEFAULT_VERSION: VersionInfo = Object.freeze({
  version: 'dev',
  commit: 'unknown',
  builtAt: 'unknown',
})

/** 并行执行依赖探针，并在应用排空期间立即报告 not_ready。 */
export class HealthService implements HealthServicePort {
  /** 三项依赖探针的实现；键名即探针名，会原样出现在 readiness 响应体里。 */
  readonly #checks: ReadinessChecks
  /** 冻结后的版本快照；version 探针只读它，不触碰外部依赖。 */
  readonly #version: VersionInfo
  /** 单个探针的超时上限（毫秒）；构造时校验必须为正有限值。 */
  readonly #timeoutMilliseconds: number
  /** 排空开关：置 true 后 ready 立即 fail closed，供停机流程摘流量。 */
  #draining = false

  public constructor(
    checks: ReadinessChecks,
    version: VersionInfo = DEFAULT_VERSION,
    timeoutMilliseconds = 1_000
  ) {
    if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
      throw new Error('readiness timeout must be greater than zero')
    }
    this.#checks = checks
    this.#version = Object.freeze({ ...version })
    this.#timeoutMilliseconds = timeoutMilliseconds
  }

  /**
   * 存活探针：进程在跑就恒为 healthy，与依赖状态无关，用于区分「进程死了」与「依赖挂了」。
   *
   * @returns 固定的 healthy 状态。
   */
  public health(): { readonly status: 'healthy' } {
    return { status: 'healthy' }
  }

  /**
   * 版本信息：从构造时冻结的快照读取，不触碰外部依赖。
   *
   * @returns 版本号、提交 SHA 与构建时间，字段名对齐对外契约的 snake_case。
   */
  public version(): {
    readonly version: string
    readonly commit: string
    readonly built_at: string
  } {
    return {
      version: this.#version.version,
      commit: this.#version.commit,
      built_at: this.#version.builtAt,
    }
  }

  /**
   * 切换排空开关：置为 true 后 `ready` 立即返回 not_ready，让负载均衡摘掉本实例。
   *
   * @param draining - 是否进入排空；进程停机流程据此止损，不阻断开机。
   */
  public setDraining(draining: boolean): void {
    this.#draining = draining
  }

  /**
   * 就绪探针：并行探测 database/redis/storage，单个探针失败被归一为 error 而不外抛；
   * 排空开关打开时短路返回 not_ready，不再探测。
   *
   * @param signal - 请求取消信号，同时作为各探针超时的父信号。
   * @returns 就绪结果；任一探针失败或超时即为 not_ready（503）。
   */
  public async ready(signal: AbortSignal): Promise<ReadinessResult> {
    if (this.#draining)
      return { status: 503, body: { status: 'not_ready', checks: { server: 'draining' } } }
    const names: readonly (keyof ReadinessChecks)[] = ['database', 'redis', 'storage']
    // 跑单个依赖探针并归一为 ok/error；探针自身失败不向外抛。
    const runCheck = async (
      name: keyof ReadinessChecks
    ): Promise<readonly [keyof ReadinessChecks, 'ok' | 'error']> => {
      try {
        await runWithTimeout(this.#checks[name], signal, this.#timeoutMilliseconds)
        return [name, 'ok']
      } catch {
        return [name, 'error']
      }
    }
    const results = await Promise.all(names.map((name) => runCheck(name)))
    const checks: Record<keyof ReadinessChecks, 'ok' | 'error'> = {
      database: 'error',
      redis: 'error',
      storage: 'error',
    }
    for (const [name, status] of results) checks[name] = status
    const ready = results.every(([, status]): boolean => status === 'ok')
    return { status: ready ? 200 : 503, body: { status: ready ? 'ready' : 'not_ready', checks } }
  }
}

/**
 * 在超时与父信号中止之间竞速运行单个依赖探针：任一先到即中止探针并抛出，区分「探针自身失败」
 * 与「探针超时」。无论成败都在 finally 里清理定时器与父信号监听，避免句柄与监听泄漏。
 *
 * @param check - 单个依赖的探针实现，接收本函数派生的子信号。
 * @param parentSignal - 请求级取消信号；客户端断开时透传中止到探针。
 * @param timeoutMilliseconds - 探针超时上限（毫秒）。
 */
async function runWithTimeout(
  check: ReadinessCheck,
  parentSignal: AbortSignal,
  timeoutMilliseconds: number
): Promise<void> {
  const controller = new AbortController()
  const abort = (): void => controller.abort(abortReason(parentSignal))
  if (parentSignal.aborted) abort()
  else parentSignal.addEventListener('abort', abort, { once: true })
  let timeout: ReturnType<typeof setTimeout> | undefined

  // executor：到点中止探针并让竞速以超时错误失败；句柄交给外层 `finally` 清理。
  function armTimeout(
    _resolve: (value: PromiseLike<never>) => void,
    reject: (reason?: unknown) => void
  ): void {
    // 探针超时：先中止 controller（探针自己也要能感知），再让竞速失败。
    function onTimeout(): void {
      controller.abort(new Error('readiness check timed out'))
      reject(new Error('readiness check timed out'))
    }

    timeout = setTimeout(onTimeout, timeoutMilliseconds)
  }

  // executor：探针被中止时让竞速以中止原因失败；父信号与超时都走同一个 controller。
  function watchProbeAbort(
    _resolve: (value: PromiseLike<never>) => void,
    reject: (reason?: unknown) => void
  ): void {
    controller.signal.addEventListener(
      'abort',
      (): void => reject(abortReason(controller.signal)),
      { once: true }
    )
  }

  const timeoutPromise = new Promise<never>(armTimeout)
  const abortPromise = new Promise<never>(watchProbeAbort)
  try {
    await Promise.race([check(controller.signal), timeoutPromise, abortPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    parentSignal.removeEventListener('abort', abort)
  }
}

/**
 * 从中止信号取出可读的中止原因：仅在 reason 是 Error 时沿用，否则回退到稳定的兜底文案，
 * 保证抛出的始终是 Error 而非任意值。
 *
 * @param signal - 被中止的信号，其 reason 可能是任意类型。
 * @returns 归一为 Error 的中止原因，供上层归一为 error 状态。
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('readiness check aborted')
}
