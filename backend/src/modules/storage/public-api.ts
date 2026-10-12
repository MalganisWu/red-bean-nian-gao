/** Storage Module 的公开入口；只导出跨模块可用的 Port 与 Module 工厂，不导出实现。 */
export { createStorageModule, type StorageModule } from './storage.module.js'
export type { ObjectDownload, ObjectInfo } from './service/application/model/object-result.js'
