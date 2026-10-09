import type {
  HealthServicePort,
  ReadinessChecks,
  VersionInfo,
} from './service/health/port/health-service.port.js'
import { HealthService } from './service/health/default-health-service.js'

/** System Module 对应用层公开的部署探针能力。 */
export interface SystemModule {
  readonly health: HealthServicePort
}

/**
 * System Module 的唯一生产组装入口。
 * Composition Root 只提供基础设施检查函数与构建版本，不直接选择 HealthService 实现。
 */
export function createSystemModule(checks: ReadinessChecks, version?: VersionInfo): SystemModule {
  return {
    health: version === undefined ? new HealthService(checks) : new HealthService(checks, version),
  }
}
