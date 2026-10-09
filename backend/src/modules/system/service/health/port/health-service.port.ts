export type ReadinessCheck = (signal: AbortSignal) => Promise<void>

export interface ReadinessChecks {
  readonly database: ReadinessCheck
  readonly redis: ReadinessCheck
  readonly storage: ReadinessCheck
}

export interface VersionInfo {
  readonly version: string
  readonly commit: string
  readonly builtAt: string
}

type CheckName = keyof ReadinessChecks
type CheckStatus = 'ok' | 'error'

export interface ReadinessResult {
  readonly status: 200 | 503
  readonly body:
    | { readonly status: 'ready' | 'not_ready'; readonly checks: Record<CheckName, CheckStatus> }
    | { readonly status: 'not_ready'; readonly checks: { readonly server: 'draining' } }
}

/**
 * 部署探针与应用生命周期共用的 System Module Port。
 * 默认实现为 `HealthService`，由 `system.module.ts` 组装。
 * liveness 不依赖外部系统；readiness 在停机排空期间必须 fail closed。
 */
export interface HealthServicePort {
  health(): { readonly status: 'healthy' }
  version(): { readonly version: string; readonly commit: string; readonly built_at: string }
  setDraining(draining: boolean): void
  ready(signal: AbortSignal): Promise<ReadinessResult>
}
