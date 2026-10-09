import type { SubExecutionRecord } from '../../model/sub-execution.js'
import type { AgentMessage } from '../../../model/agent-message.js'

/**
 * 子执行的宿主持久化边界，由 Agent Module 拥有。
 * 默认实现是 `PostgresSubExecutionRepository`，在 `agent.module.ts` 显式组装。
 */
export interface SubExecutionRepository {
  create(record: SubExecutionRecord, signal: AbortSignal): Promise<void>
  getById(executionId: string, signal: AbortSignal): Promise<SubExecutionRecord | undefined>
  listPending(sessionId: string, signal: AbortSignal): Promise<readonly SubExecutionRecord[]>
  /** 按会话读取全部子执行记录（只读审计用，如会话轨迹投影）。 */
  listBySession(sessionId: string, signal: AbortSignal): Promise<readonly SubExecutionRecord[]>
  /**
   * 以候选快照的 revision 原子认领 pending 记录，并返回认领后的完整最新记录。
   * 返回前必须递增 revision，使旧执行 owner 后续追加恢复日志失败。
   */
  claimPending(
    executionId: string,
    revision: bigint,
    signal: AbortSignal
  ): Promise<SubExecutionRecord>
  /** 仅允许可恢复终态以期望 revision 原子进入 running，并返回新的 revision。 */
  claimResume(
    record: SubExecutionRecord,
    leaseExpiredBefore: Date,
    signal: AbortSignal
  ): Promise<void>
  /** 仅当前 revision 的 running owner 可以续租；失配必须明确失败。 */
  renewResumeLease(
    executionId: string,
    revision: bigint,
    renewedAt: Date,
    signal: AbortSignal
  ): Promise<void>
  /** 仅当前 revision owner 可追加恢复日志；追加与 ownership 校验由数据库原子完成。 */
  appendRecoveryMessage(
    executionId: string,
    revision: bigint,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void>
  /** 以 record.revision 为期望版本原子更新；成功后回写递增后的 revision。 */
  update(record: SubExecutionRecord, signal: AbortSignal): Promise<void>
}
