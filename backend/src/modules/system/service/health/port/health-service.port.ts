/** 单个依赖的就绪探测；不健康时以抛错表示，如何呈现在响应里由实现决定。 */
export type ReadinessCheck = (signal: AbortSignal) => Promise<void>

/** 三项外部依赖的探针；字段名即探针名，会原样出现在 readiness 响应体里。 */
export interface ReadinessChecks {
  readonly database: ReadinessCheck
  readonly redis: ReadinessCheck
  readonly storage: ReadinessCheck
}

/** 版本信息；三项都会原样出现在 version 探针的响应体里。 */
export interface VersionInfo {
  readonly version: string
  readonly commit: string
  readonly builtAt: string
}

type CheckName = keyof ReadinessChecks
type CheckStatus = 'ok' | 'error'

/** readiness 响应；`200` 就绪、`503` 不可用，body 分两态——停机排空中的 server 只报 `draining`。 */
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
