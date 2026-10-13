import type {
  HealthServicePort,
  ReadinessResult,
} from '../service/health/port/health-service.port.js'

/**
 * System 部署探针的 HTTP 用例控制器：不接触 Fastify 类型，
 * 返回裸响应体，HTTP 状态码由 `health.routes.ts` 决定。
 */
export class HealthController {
  /** 探针能力 Port；由构造器注入，控制器只做用例编排、不持有其生命周期。 */
  readonly #health: HealthServicePort

  public constructor(health: HealthServicePort) {
    this.#health = health
  }

  /**
   * 存活探针：进程还在跑就恒为 healthy，不触碰任何外部依赖，避免依赖抖动引发误杀。
   *
   * @returns 固定的 healthy 状态，本探针不会失败。
   */
  public health(): { readonly status: 'healthy' } {
    return this.#health.health()
  }

  /**
   * 就绪探针：聚合外部依赖的探测结果，由路由层据此决定 HTTP 状态码。
   *
   * @param signal - 请求取消信号，客户端断开时中止仍在等待的探针。
   * @returns 含状态码与各依赖明细的就绪结果；依赖未齐时状态为 not_ready。
   */
  public ready(signal: AbortSignal): Promise<ReadinessResult> {
    return this.#health.ready(signal)
  }

  /**
   * 版本信息：把内部 camelCase 快照摊平成对外的 snake_case 字段。
   *
   * @returns 版本号、提交 SHA 与构建时间，三者均来自组装时注入的版本快照。
   */
  public version(): {
    readonly version: string
    readonly commit: string
    readonly built_at: string
  } {
    return this.#health.version()
  }
}
