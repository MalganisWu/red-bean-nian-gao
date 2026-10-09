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
  /** 创建 run 容器（status=running、facts 为空序列），run_index 由存储侧按会话内序分配。 */
  create(run: StartSessionRunCommand, signal: AbortSignal): Promise<SessionRunRecord>
  /** 向未终态的 run 追加一条事实记录（JSONB 追加，保持到达顺序）。 */
  appendFact(runId: string, fact: RunFact, signal: AbortSignal): Promise<void>
  /** 把 run 容器推进到终态（completed/failed/cancelled/interrupted/exhausted）。 */
  finalize(runId: string, command: FinalizeSessionRunCommand, signal: AbortSignal): Promise<void>
  /** 按会话内序（run_index 升序）读取该会话全部 run 记录；轨迹读取端据此判断是否切换数据源。 */
  listBySession(sessionId: string, signal: AbortSignal): Promise<readonly SessionRunRecord[]>
}
