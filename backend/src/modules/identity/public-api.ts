/** Identity Module 的公开入口；只导出跨模块可用的 Port 与 Module 工厂，不导出实现。 */
export { createIdentityModule, type IdentityModule } from './identity.module.js'
export type { AuthServicePort } from './service/authentication/port/auth-service.port.js'
export type { PasswordHasher } from './service/authentication/port/password-hasher.port.js'
