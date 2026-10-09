import type { ObjectStorage } from '../object-storage/port/object-storage.js'
import type { StorageHealthPort } from './port/storage-health.port.js'

/** 通过 Module 私有 ObjectStorage 验证对象存储连通性。 */
export class StorageHealthService implements StorageHealthPort {
  readonly #storage: ObjectStorage

  public constructor(storage: ObjectStorage) {
    this.#storage = storage
  }

  public async check(signal: AbortSignal): Promise<void> {
    await this.#storage.stat('.health-check', signal)
  }
}
