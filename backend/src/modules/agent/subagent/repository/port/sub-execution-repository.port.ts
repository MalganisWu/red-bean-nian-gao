import type { SubExecutionRecord } from '../../model/sub-execution.js'
import type { AgentMessage } from '../../../model/agent-message.js'

/**
 * 子执行的宿主持久化边界，由 Agent Module 拥有。
 * 默认实现是 `PostgresSubExecutionRepository`，在 `agent.module.ts` 显式组装。
 */
export interface SubExecutionRepository {
  /**
   * 新建一条子执行记录；executionId 冲突视为调用方错误而非覆盖写。
   *
   * @param record - 待写入的记录快照。
   * @param signal - 中止信号，透传到 SQL。
   */
  create(record: SubExecutionRecord, signal: AbortSignal): Promise<void>
  /**
   * 按标识读取记录。
   *
   * @param executionId - 目标子执行标识。
   * @param signal - 中止信号，透传到 SQL。
   * @returns 记录；不存在时返回 undefined。
   */
  getById(executionId: string, signal: AbortSignal): Promise<SubExecutionRecord | undefined>
  /**
   * 列出会话下仍处于 pending 的子执行；宿主恢复用它挑选待收束的记录。
   *
   * @param sessionId - 目标会话标识。
   * @param signal - 中止信号，透传到 SQL。
   * @returns pending 记录列表；没有待恢复项时为空数组。
   */
  listPending(sessionId: string, signal: AbortSignal): Promise<readonly SubExecutionRecord[]>
  /**
   * 按会话读取全部子执行记录（只读审计用，如会话轨迹投影）。
   *
   * @param sessionId - 目标会话标识。
   * @param signal - 中止信号，透传到 SQL。
   * @returns 该会话下的全部子执行记录。
   */
  listBySession(sessionId: string, signal: AbortSignal): Promise<readonly SubExecutionRecord[]>
  /**
   * 以候选快照的 revision 原子认领 pending 记录，并返回认领后的完整最新记录。
   * 返回前必须递增 revision，使旧执行 owner 后续追加恢复日志失败。
   *
   * @param executionId - 目标子执行标识。
   * @param revision - 期望的 CAS 版本；与库中不符即认领失败。
   * @param signal - 中止信号，透传到 SQL。
   * @returns 认领后的完整最新记录。
   */
  claimPending(
    executionId: string,
    revision: bigint,
    signal: AbortSignal
  ): Promise<SubExecutionRecord>
  /**
   * 仅允许可恢复终态以期望 revision 原子进入 running，并返回新的 revision。
   *
   * @param record - 候选快照；其 status 必须可恢复，revision 作为 CAS 基准。
   * @param leaseExpiredBefore - 只认领租约已过期的记录，避免抢占仍在运行的 owner。
   * @param signal - 中止信号，透传到 SQL。
   */
  claimResume(
    record: SubExecutionRecord,
    leaseExpiredBefore: Date,
    signal: AbortSignal
  ): Promise<void>
  /**
   * 仅当前 revision 的 running owner 可以续租；失配必须明确失败。
   *
   * @param executionId - 目标子执行标识。
   * @param revision - 当前 owner 持有的版本；不符即续租失败。
   * @param renewedAt - 本次续租的时间戳，写入记录以延后租约过期。
   * @param signal - 中止信号，透传到 SQL。
   */
  renewResumeLease(
    executionId: string,
    revision: bigint,
    renewedAt: Date,
    signal: AbortSignal
  ): Promise<void>
  /**
   * 仅当前 revision owner 可追加恢复日志；追加与 ownership 校验由数据库原子完成。
   *
   * @param executionId - 目标子执行标识。
   * @param revision - 当前 owner 持有的版本；不符即拒绝追加。
   * @param message - 待追加的恢复消息。
   * @param signal - 中止信号，透传到 SQL。
   */
  appendRecoveryMessage(
    executionId: string,
    revision: bigint,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void>
  /**
   * 以 record.revision 为期望版本原子更新；成功后回写递增后的 revision。
   *
   * @param record - 待更新的记录；其 revision 进 WHERE 做 CAS，成功后就地递增。
   * @param signal - 中止信号，透传到 SQL。
   */
  update(record: SubExecutionRecord, signal: AbortSignal): Promise<void>
}
