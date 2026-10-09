import type { Session, SessionSummary } from '../../model/session.js'

/**
 * Agent Module 的会话持久化边界。
 * 默认实现为 PostgresSessionRepository，由 agent.module.ts 组装；内存实现仅用于测试。
 */
export interface SessionRepository {
  getOrCreate(sessionId: string, userId: string, signal: AbortSignal): Promise<Session>
  getById(sessionId: string, userId: string, signal: AbortSignal): Promise<Session>
  save(session: Session, signal: AbortSignal): Promise<void>
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
  advanceFence(sessionId: string, userId: string, token: bigint, signal: AbortSignal): Promise<void>
}
