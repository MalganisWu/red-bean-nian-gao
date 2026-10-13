import type { RunFact } from '../model/run-fact.js'
import type {
  FinalizeSessionRunCommand,
  SessionRunRecord,
  StartSessionRunCommand,
} from '../model/session-run.js'

/**
 * 会话事实日志（session_runs）的出站持久化边界。
 * 默认实现为 `PostgresRunFactRepository`，由 `agent.module.ts` 组装；
 * 运行时写入路径（`ProductAgentRunService`）与轨迹读取端都依赖本 Port。
 *
 * append-only 语义：run 容器只创建一次，facts 只追加，状态只从 running 推进到终态；
 * 对已终态 run 的追加/再次终态化会被适配器拒绝。
 */
export interface RunFactRepository {
  /**
   * 创建 run 容器（status=running、facts 为空序列），run_index 由存储侧按会话内序分配。
   * @param run 创建容器的身份与路由元数据
   * @param signal 传给 SQL 执行器的中止信号；中止即放弃创建，不留半条记录
   * @returns 落库后的容器记录，run_index 已由存储侧分配
   */
  create(run: StartSessionRunCommand, signal: AbortSignal): Promise<SessionRunRecord>
  /**
   * 向未终态的 run 追加一条事实记录（JSONB 追加，保持到达顺序）。
   * @param runId 目标 run 容器 ID；不存在或已终态时由适配器拒绝
   * @param fact 一条带 schemaVersion 的事实
   * @param signal SQL 中止信号；中止即放弃本次追加
   */
  appendFact(runId: string, fact: RunFact, signal: AbortSignal): Promise<void>
  /**
   * 把 run 容器推进到终态（completed/failed/cancelled/interrupted/exhausted）。
   * @param runId 目标 run 容器 ID；不存在或已终态时由适配器拒绝
   * @param command 终态命令，取消归属与结束时刻由调用方给出
   * @param signal SQL 中止信号
   */
  finalize(runId: string, command: FinalizeSessionRunCommand, signal: AbortSignal): Promise<void>
  /**
   * 按会话内序（run_index 升序）读取该会话全部 run 记录；轨迹读取端据此判断是否切换数据源。
   * @param sessionId 会话 ID；无记录时返回空数组而非 undefined
   * @param signal SQL 中止信号
   * @returns 会话内的 run 记录，按 run_index 升序
   */
  listBySession(sessionId: string, signal: AbortSignal): Promise<readonly SessionRunRecord[]>
}
