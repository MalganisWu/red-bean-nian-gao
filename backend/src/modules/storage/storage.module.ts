import type { AppConfig } from '../../infra/config/config.js'
import type { StorageHealthPort } from './service/application/port/storage-health.port.js'
import { StorageService } from './service/application/storage-service.js'
import { StorageHealthService } from './service/application/storage-health-service.js'
import { MinioObjectStorage } from './service/object-storage/minio-object-storage.js'

export interface StorageModule {
  readonly storageService: StorageService
  readonly health: StorageHealthPort
}

/** 创建并初始化 Storage Module；Bucket 生命周期由该模块拥有。 */
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
