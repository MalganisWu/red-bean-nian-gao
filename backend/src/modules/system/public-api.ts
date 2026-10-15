// System Module 的公开入口；健康探针 Port 与 Module 工厂。
export { createSystemModule, type SystemModule } from './system.module.js'
export type {
  HealthServicePort,
  ReadinessCheck,
  ReadinessChecks,
  ReadinessResult,
  VersionInfo,
} from './service/health/port/health-service.port.js'
