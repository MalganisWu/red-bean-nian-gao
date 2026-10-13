/** 宿主基础设施错误码；Runtime SDK 不感知产品锁与请求注册语义。 */
export const REGISTRY_ERROR_CODES = Object.freeze({
  LOCK_CONFLICT: 'session_lock_conflict',
  LEASE_LOST: 'session_lease_lost',
  REQUEST_ALREADY_REGISTERED: 'request_already_registered',
} as const)

/** 基础设施错误码的字面量联合；只覆盖锁与请求注册，Runtime SDK 不感知这些语义。 */
export type RegistryErrorCode = (typeof REGISTRY_ERROR_CODES)[keyof typeof REGISTRY_ERROR_CODES]

/**
 * 错误码到默认 message 的映射；只作日志与人工排查用的英文短句。
 * 调用方不应据 message 分支——它可能被上层重写或本地化，判据只有 `code`。
 */
const REGISTRY_ERROR_MESSAGES: Readonly<Record<RegistryErrorCode, string>> = Object.freeze({
  session_lock_conflict: 'session lock conflict',
  session_lease_lost: 'session lease lost',
  request_already_registered: 'request already registered',
})

/** 基础设施异常；message 由内部码表统一给出，调用方只应依据 `code` 分支。 */
export class RegistryError extends Error {
  /** 机器判据；`message` 可能被上层重写或本地化，分支判断只应依据本字段。 */
  public readonly code: RegistryErrorCode

  public constructor(code: RegistryErrorCode, options?: ErrorOptions) {
    super(REGISTRY_ERROR_MESSAGES[code], options)
    this.name = 'RegistryError'
    this.code = code
  }
}

/** Session 互斥租约；普通对话、任务调度与结果投递共享同一所有权语义。 */
export interface SessionLease {
  /** 获授锁的次序令牌；回写时随会话带上，令牌落后于当前值即视为锁已旁落。 */
  readonly fencingToken?: bigint
  /** 仅供 Redis 原子校验写入所有权的不透明证明。 */
  readonly writeProof?: string
  /** 续租失败时兑现的失租信号；运行与持久化边界据此中止后续写入。 */
  readonly lost?: Promise<Error>
  /** 释放租约；调用方负责在运行结束时归还，重复调用应幂等。 */
  release(): void | Promise<void>
}

/**
 * Agent Module 对外提供的 Session 锁能力。
 * 默认实现为 `RedisSessionLockRegistry`，由 `agent.module.ts` 创建；调用方负责释放 lease，
 * Redis 续租失败通过 `lost` Promise 传播给运行与持久化边界。
 */
export interface SessionLockRegistry {
  /**
   * 尝试获取会话锁；锁已被他人持有时以 `RegistryError` 的锁冲突码失败，由调用方决定重试还是拒绝。
   * 获取成功后的租约必须在运行结束时释放，否则会阻塞同一会话的后续请求，也可能拖到租约过期。
   *
   * @param sessionId - 目标会话标识；同一会话全局互斥。
   * @param requestId - 请求标识；用于注册当前持有者，重复注册同一请求视为冲突。
   * @param signal - 中止信号；取消后不再继续等待或建立续租。
   * @returns 获授的会话租约；实现可同步返回，也可异步返回。
   */
  tryAcquire(
    sessionId: string,
    requestId: string,
    signal?: AbortSignal
  ): SessionLease | Promise<SessionLease>
}

/** 生成产品实体标识；生产默认实现由 Composition Root 注入。 */
