import type { RedisConnection } from './../../../../infra/redis/redis.js'
import type { DeliveryQueueStore } from './port/delivery-queue.port.js'

/** DeliveryQueue 所需原子列表操作的 Redis 实现。 */
export class RedisDeliveryQueueStore implements DeliveryQueueStore {
  readonly #redis: RedisConnection

  public constructor(redis: RedisConnection) {
    this.#redis = redis
  }

  public rightPush(key: string, value: string, signal: AbortSignal): Promise<void> {
    return this.#redis.listRightPush(key, value, signal)
  }

  public list(key: string, signal: AbortSignal): Promise<readonly string[]> {
    return this.#redis.listRange(key, signal)
  }

  public claim(
    sourceKey: string,
    processingKey: string,
    signal: AbortSignal
  ): Promise<string | undefined> {
    return this.#redis.listClaim(sourceKey, processingKey, signal)
  }

  public requeue(
    sourceKey: string,
    processingKey: string,
    entry: string,
    signal: AbortSignal
  ): Promise<void> {
    return this.#redis.listRequeue(sourceKey, processingKey, entry, signal)
  }

  public recover(sourceKey: string, processingKey: string, signal: AbortSignal): Promise<void> {
    return this.#redis.listRecover(sourceKey, processingKey, signal)
  }

  public remove(processingKey: string, entry: string, signal: AbortSignal): Promise<void> {
    return this.#redis.listRemove(processingKey, entry, signal)
  }
}
