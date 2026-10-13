import type { AppConfig } from '../../infra/config/config.js'
import type { StorageHealthPort } from './service/application/port/storage-health.port.js'
import { StorageService } from './service/application/storage-service.js'
import { StorageHealthService } from './service/application/storage-health-service.js'
import { MinioObjectStorage } from './service/object-storage/minio-object-storage.js'

/** Storage Module 的输出面：对象用例服务与健康探针。 */
export interface StorageModule {
  /** 对象用例服务；跨 Module 只经它读写对象，MinIO 具体类不外泄。 */
  readonly storageService: StorageService
  /** 健康探针 Port；供应用 readiness 检查对象存储连通性。 */
  readonly health: StorageHealthPort
}

/**
 * 创建并初始化 Storage Module；Bucket 生命周期由该模块拥有。
 *
 * 是 Module 内实现选择的事实来源：跨 Module 只暴露用例服务与健康 Port，MinIO 具体类不外泄。
 * 组装即触发一次 bucket 就绪检查，因此本函数是异步的，且失败会让启动失败。
 *
 * @param config - `config.minio` 段；凭据等敏感字段只在此透传，不落日志
 * @param signal - 启动期取消信号，透传给 bucket 就绪检查
 * @returns 对象用例服务与健康探针
 */
export async function createStorageModule(
  config: AppConfig['minio'],
  signal: AbortSignal
): Promise<StorageModule> {
  const storage = new MinioObjectStorage({
    endpoint: config.endpoint,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    bucket: config.bucket,
    useSsl: config.useSsl,
    region: config.region,
  })
  await storage.ensureBucket(signal)
  const storageService = new StorageService(storage)
  return { storageService, health: new StorageHealthService(storage) }
}
