import type { Session, SessionSummary } from '../../model/session.js'

/**
 * Agent Module 的会话持久化边界。
 * 默认实现为 PostgresSessionRepository，由 agent.module.ts 组装；内存实现仅用于测试。
 */
export interface SessionRepository {
  /**
   * 取回会话，不存在则以给定 id 新建一条。
   *
   * @param sessionId - 会话标识；新建时用它作为主键。
   * @param userId - 会话归属用户；新建时写入归属，查回时用于校验所有权。
   * @param signal - 中止信号；取消后放弃本次读写。
   * @returns 既有或新建的会话聚合，带上当前 revision 与 fencing 令牌。
   */
  getOrCreate(sessionId: string, userId: string, signal: AbortSignal): Promise<Session>
  /**
   * 按 id 取会话；不属于该用户时按不存在处理，不泄露他人会话的存在性。
   *
   * @param sessionId - 会话标识。
   * @param userId - 期望的归属用户；与记录不符时以 `SessionNotFoundError` 失败。
   * @param signal - 中止信号；取消后放弃本次读取。
   * @returns 归属匹配的会话聚合。
   */
  getById(sessionId: string, userId: string, signal: AbortSignal): Promise<Session>
  /**
   * 以 CAS 方式保存会话；`session.revision` 与库中不一致时以版本冲突失败，避免覆盖并发写。
   *
   * @param session - 待保存的会话聚合；需带上读回时的 revision 与 fencing 令牌。
   * @param signal - 中止信号；取消后放弃本次写入。
   */
  save(session: Session, signal: AbortSignal): Promise<void>
  /**
   * 按用户分页列出会话摘要，按更新时间倒序。
   *
   * @param userId - 目标归属用户。
   * @param cursor - 上一页返回的游标；空串表示从头开始。
   * @param limit - 本页最多返回的条数。
   * @param signal - 中止信号；取消后放弃本次查询。
   * @returns 本页会话摘要；到达末页时为空数组。
   */
  listByUser(
    userId: string,
    cursor: string,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly SessionSummary[]>
}

/**
 * 支持 fencing token 推进的生产会话仓储能力。
 * 默认实现为 `PostgresSessionRepository`，由 `agent.module.ts` 组装；CAS 冲突必须向调用方报告。
 */
export interface FencedSessionRepository extends SessionRepository {
  /**
   * 把会话的 fencing 令牌推进到给定值；只在获取锁后调用，用于确立本轮写入的围栏。
   *
   * @param sessionId - 目标会话标识。
   * @param userId - 期望的归属用户；不符时按不存在处理。
   * @param token - 新的围栏序号；应大于等于库中当前值，落后时以 CAS 冲突失败。
   * @param signal - 中止信号；取消后放弃本次推进。
   */
  advanceFence(sessionId: string, userId: string, token: bigint, signal: AbortSignal): Promise<void>
}
