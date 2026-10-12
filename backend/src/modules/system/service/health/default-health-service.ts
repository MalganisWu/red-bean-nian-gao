import type {
  HealthServicePort,
  ReadinessCheck,
  ReadinessChecks,
  ReadinessResult,
  VersionInfo,
} from './port/health-service.port.js'

const DEFAULT_VERSION: VersionInfo = Object.freeze({
  version: 'dev',
  commit: 'unknown',
  builtAt: 'unknown',
})

/** 并行执行依赖探针，并在应用排空期间立即报告 not_ready。 */
export class HealthService implements HealthServicePort {
  readonly #checks: ReadinessChecks
  readonly #version: VersionInfo
  readonly #timeoutMilliseconds: number
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

  public health(): { readonly status: 'healthy' } {
    return { status: 'healthy' }
  }

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

  public setDraining(draining: boolean): void {
    this.#draining = draining
  }

  public async ready(signal: AbortSignal): Promise<ReadinessResult> {
    if (this.#draining)
      return { status: 503, body: { status: 'not_ready', checks: { server: 'draining' } } }
    const names: readonly (keyof ReadinessChecks)[] = ['database', 'redis', 'storage']
    /** 跑单个依赖探针并归一为 ok/error；探针自身失败不向外抛。 */
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

  /** executor：到点中止探针并让竞速以超时错误失败；句柄交给外层 `finally` 清理。 */
  function armTimeout(
    _resolve: (value: PromiseLike<never>) => void,
    reject: (reason?: unknown) => void
  ): void {
    /** 探针超时：先中止 controller（探针自己也要能感知），再让竞速失败。 */
    function onTimeout(): void {
      controller.abort(new Error('readiness check timed out'))
      reject(new Error('readiness check timed out'))
    }

    timeout = setTimeout(onTimeout, timeoutMilliseconds)
  }

  /** executor：探针被中止时让竞速以中止原因失败；父信号与超时都走同一个 controller。 */
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

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('readiness check aborted')
}
