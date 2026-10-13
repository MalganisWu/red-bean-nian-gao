/** 单个依赖的就绪探测；不健康时以抛错表示，如何呈现在响应里由实现决定。 */
export type ReadinessCheck = (signal: AbortSignal) => Promise<void>

/** 三项外部依赖的探针；字段名即探针名，会原样出现在 readiness 响应体里。 */
export interface ReadinessChecks {
  /** 主数据库连通性探针；数据库不可用时 readiness 报 not_ready。 */
  readonly database: ReadinessCheck
  /** Redis 连通性探针；缓存/队列依赖不可用时 readiness 报 not_ready。 */
  readonly redis: ReadinessCheck
  /** 对象存储连通性探针；存储依赖不可用时 readiness 报 not_ready。 */
  readonly storage: ReadinessCheck
}

/** 版本信息；三项都会原样出现在 version 探针的响应体里。 */
export interface VersionInfo {
  /** 语义化版本号；缺省占位为 `dev`。 */
  readonly version: string
  /** 构建来源的提交 SHA；缺省占位为 `unknown`。 */
  readonly commit: string
  /** 构建时间（ISO 8601 字符串）；缺省占位为 `unknown`。 */
  readonly builtAt: string
}

/** 依赖探针名，取自 ReadinessChecks 的键，保证与探针清单始终一致。 */
type CheckName = keyof ReadinessChecks

/** 单个依赖探测结果的二值状态：`ok` 通过，`error` 失败（含超时）。 */
type CheckStatus = 'ok' | 'error'

/** readiness 响应；`200` 就绪、`503` 不可用，body 分两态——停机排空中的 server 只报 `draining`。 */
export interface ReadinessResult {
  /** 建议的 HTTP 状态码：就绪为 200，不可用为 503。 */
  readonly status: 200 | 503
  /** 裸响应体（非业务信封），其判别字段 status 与 HTTP 状态码保持同义。 */
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
  /**
   * 存活探针：只反映进程是否还能响应，不触碰任何外部依赖。
   *
   * @returns 固定的 healthy 标记，本探针不会失败。
   */
  health(): { readonly status: 'healthy' }

  /**
   * 版本信息：从组装时注入的构建快照读取，字段名对齐对外契约的 snake_case。
   *
   * @returns 版本号、提交 SHA 与构建时间。
   */
  version(): { readonly version: string; readonly commit: string; readonly built_at: string }

  /**
   * 切换排空开关：置为 true 后 ready 立即 fail closed，让负载均衡摘掉本实例。
   *
   * @param draining - 是否进入排空状态，由停机流程驱动。
   */
  setDraining(draining: boolean): void

  /**
   * 就绪探针：聚合全部依赖探测结果，停机排空期间必须 fail closed。
   *
   * @param signal - 请求取消信号，同时作为各探针超时的父信号。
   * @returns 含状态码与各依赖明细的就绪结果；任一依赖失败或超时即为 not_ready。
   */
  ready(signal: AbortSignal): Promise<ReadinessResult>
}
