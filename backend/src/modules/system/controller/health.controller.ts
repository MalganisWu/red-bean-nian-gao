import type {
  HealthServicePort,
  ReadinessResult,
} from '../service/health/port/health-service.port.js'

/**
 * System 部署探针的 HTTP 用例控制器：不接触 Fastify 类型，
 * 返回裸响应体，HTTP 状态码由 `health.routes.ts` 决定。
 */
export class HealthController {
  readonly #health: HealthServicePort

  public constructor(health: HealthServicePort) {
    this.#health = health
  }

  public health(): { readonly status: 'healthy' } {
    return this.#health.health()
  }

  public ready(signal: AbortSignal): Promise<ReadinessResult> {
    return this.#health.ready(signal)
  }

  public version(): {
    readonly version: string
    readonly commit: string
    readonly built_at: string
  } {
    return this.#health.version()
  }
}
