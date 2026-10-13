import type { RedisConnection } from './../../../../infra/redis/redis.js'
import type { DeliveryQueueStore } from './port/delivery-queue.port.js'

/** DeliveryQueue 所需原子列表操作的 Redis 实现。 */
export class RedisDeliveryQueueStore implements DeliveryQueueStore {
  /** Redis 连接；本存储依赖其提供的原子列表搬运原语。 */
  readonly #redis: RedisConnection

  public constructor(redis: RedisConnection) {
    this.#redis = redis
  }

  /**
   * 把条目追加到列表尾部，先入先出；条目内容对存储层不透明，由调用方约定编码。
   *
   * @param key - 目标列表的 Redis 键。
   * @param value - 待追加的条目内容。
   * @param signal - 取消信号，透传到 Redis 客户端。
   */
  public rightPush(key: string, value: string, signal: AbortSignal): Promise<void> {
    return this.#redis.listRightPush(key, value, signal)
  }

  /**
   * 读取列表全部条目，用于对账时判断哪些执行已在队列里。
   *
   * @param key - 目标列表的 Redis 键。
   * @param signal - 取消信号，透传到 Redis 客户端。
   * @returns 列表内的全部条目，顺序与写入一致。
   */
  public list(key: string, signal: AbortSignal): Promise<readonly string[]> {
    return this.#redis.listRange(key, signal)
  }

  /**
   * 原子地把一条待办移到 processing 列表并返回，保证「取出即不再被别人取到」。
   *
   * @param sourceKey - 待办列表键，从头部取。
   * @param processingKey - 处理中列表键，取出的条目移入此处。
   * @param signal - 取消信号，透传到 Redis 客户端。
   * @returns 认领到的条目；待办为空时返回 `undefined`。
   */
  public claim(
    sourceKey: string,
    processingKey: string,
    signal: AbortSignal
  ): Promise<string | undefined> {
    return this.#redis.listClaim(sourceKey, processingKey, signal)
  }

  /**
   * 投递失败时把条目从 processing 放回待办，与 `claim` 互为逆操作；顺序不能反。
   *
   * @param sourceKey - 待办列表键，条目放回这里。
   * @param processingKey - 处理中列表键，条目从这里移出。
   * @param entry - 要放回的条目，须与 `claim` 返回的一致。
   * @param signal - 取消信号，透传到 Redis 客户端。
   */
  public requeue(
    sourceKey: string,
    processingKey: string,
    entry: string,
    signal: AbortSignal
  ): Promise<void> {
    return this.#redis.listRequeue(sourceKey, processingKey, entry, signal)
  }

  /**
   * 崩溃恢复：把上次崩溃滞留在 processing 的条目整体搬回待办，`drain` 开头必调。
   *
   * @param sourceKey - 待办列表键。
   * @param processingKey - 处理中列表键，其中的残留条目会被搬空。
   * @param signal - 取消信号，透传到 Redis 客户端。
   */
  public recover(sourceKey: string, processingKey: string, signal: AbortSignal): Promise<void> {
    return this.#redis.listRecover(sourceKey, processingKey, signal)
  }

  /**
   * 投递成功后从 processing 摘除条目；摘除前的重复投递由 `delivered` 标记位兜底。
   *
   * @param processingKey - 处理中列表键。
   * @param entry - 要摘除的条目。
   * @param signal - 取消信号，透传到 Redis 客户端。
   */
  public remove(processingKey: string, entry: string, signal: AbortSignal): Promise<void> {
    return this.#redis.listRemove(processingKey, entry, signal)
  }
}
