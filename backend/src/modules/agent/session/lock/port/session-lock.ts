/** 宿主基础设施错误码；Runtime SDK 不感知产品锁与请求注册语义。 */
export const REGISTRY_ERROR_CODES = Object.freeze({
  LOCK_CONFLICT: 'session_lock_conflict',
  LEASE_LOST: 'session_lease_lost',
  REQUEST_ALREADY_REGISTERED: 'request_already_registered',
} as const)

export type RegistryErrorCode = (typeof REGISTRY_ERROR_CODES)[keyof typeof REGISTRY_ERROR_CODES]

const REGISTRY_ERROR_MESSAGES: Readonly<Record<RegistryErrorCode, string>> = Object.freeze({
  session_lock_conflict: 'session lock conflict',
  session_lease_lost: 'session lease lost',
  request_already_registered: 'request already registered',
})

export class RegistryError extends Error {
  public readonly code: RegistryErrorCode

  public constructor(code: RegistryErrorCode, options?: ErrorOptions) {
    super(REGISTRY_ERROR_MESSAGES[code], options)
    this.name = 'RegistryError'
    this.code = code
  }
}

/** Session 互斥租约；普通对话、任务调度与结果投递共享同一所有权语义。 */
export interface SessionLease {
  readonly fencingToken?: bigint
  /** 仅供 Redis 原子校验写入所有权的不透明证明。 */
  readonly writeProof?: string
  readonly lost?: Promise<Error>
  release(): void | Promise<void>
}

/**
 * Agent Module 对外提供的 Session 锁能力。
 * 默认实现为 `RedisSessionLockRegistry`，由 `agent.module.ts` 创建；调用方负责释放 lease，
 * Redis 续租失败通过 `lost` Promise 传播给运行与持久化边界。
 */
export interface SessionLockRegistry {
  tryAcquire(
    sessionId: string,
    requestId: string,
    signal?: AbortSignal
  ): SessionLease | Promise<SessionLease>
}

/** 生成产品实体标识；生产默认实现由 Composition Root 注入。 */
