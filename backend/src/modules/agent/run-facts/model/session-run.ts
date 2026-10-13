import type { AgentJsonValue } from '../../model/json-value.js'
import type { RunFact } from './run-fact.js'

/**
 * session_runs 行的 run 容器模型（ADR：docs/decisions/2026-09-11-session-trajectory-fact-log.md）。
 * 一个 run 一行 append-only：状态只从 running 向终态单向推进。
 * 时间字段在领域内一律 epoch 毫秒，PostgreSQL TIMESTAMPTZ 的转换收口在 row mapper。
 */

/** run 生命周期状态；终态成员由 FinalizeSessionRunCommand 之外单独收敛。 */
export const SESSION_RUN_STATUSES = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
  EXHAUSTED: 'exhausted',
} as const)

/** run 状态的字面量联合；状态只从 `running` 单向推进到某个终态，不会回退。 */
export type SessionRunStatus = (typeof SESSION_RUN_STATUSES)[keyof typeof SESSION_RUN_STATUSES]

/** 取消归属；chat cancel 属于用户取消。 */
export const SESSION_RUN_CANCELLED_BY = Object.freeze({
  USER: 'user',
  SYSTEM: 'system',
} as const)

/** 取消归属的字面量联合；用户主动取消记 `user`，系统侧（停机排空等）记 `system`。 */
export type SessionRunCancelledBy =
  (typeof SESSION_RUN_CANCELLED_BY)[keyof typeof SESSION_RUN_CANCELLED_BY]

/** run 容器 schema 版本；与 facts 内记录的版本纪律一致。 */
export const SESSION_RUN_SCHEMA_VERSION = 1

/** 除 `running` 之外的终态集合；`FinalizeSessionRunCommand` 只接受它，从类型上杜绝「终止到 running」。 */
export type SessionRunTerminalStatus = Exclude<
  SessionRunStatus,
  (typeof SESSION_RUN_STATUSES)['RUNNING']
>

/** 创建 run 容器（开始一次运行）所需的身份与路由元数据；run_index 与 facts 由存储侧负责。 */
export interface StartSessionRunCommand {
  /** 本次运行的唯一 ID，由调用方生成，用于日志定位。 */
  readonly runId: string
  /** 所属会话 ID；run_index 按会话内序分配。 */
  readonly sessionId: string
  /** 发起运行的用户 ID。 */
  readonly userId: string
  /** 模型服务商标识。 */
  readonly provider: string
  /** 本轮使用的模型名。 */
  readonly model: string
  /** 模型上下文窗口；Agent 未配置时为 null。 */
  readonly contextWindow: number | null
  /** 运行开始时刻（epoch 毫秒）。 */
  readonly startedAt: number
  /** 系统提示词 + 工具目录快照；变更才记，首版不写（nullable 列保留）。 */
  readonly header?: AgentJsonValue | undefined
}

/** 把 run 容器推进到终态的命令。 */
export interface FinalizeSessionRunCommand {
  /** 目标终态；类型上只接受非 running 的终态，杜绝「终止到 running」。 */
  readonly status: SessionRunTerminalStatus
  /** 运行结束时刻（epoch 毫秒）。 */
  readonly endedAt: number
  /** 取消发生时刻；非取消终态不写。 */
  readonly cancelledAt?: number | undefined
  /** 取消归属；非取消终态不写。 */
  readonly cancelledBy?: SessionRunCancelledBy | undefined
  /** 失败原因文本；非失败终态不写。 */
  readonly error?: string | undefined
}

/** 已持久化的 run 容器记录（含已 append 的事实序列）。 */
export interface SessionRunRecord {
  /** 本次运行的唯一 ID。 */
  readonly runId: string
  /** 所属会话 ID。 */
  readonly sessionId: string
  /** 发起运行的用户 ID。 */
  readonly userId: string
  /** 会话内递增序号（从 0 开始），由存储侧在插入时分配。 */
  readonly runIndex: number
  /** 模型服务商标识。 */
  readonly provider: string
  /** 本轮使用的模型名。 */
  readonly model: string
  /** 模型上下文窗口；未配置时为 null。 */
  readonly contextWindow: number | null
  /** 当前生命周期状态；读取到的记录通常已是终态。 */
  readonly status: SessionRunStatus
  /** 取消发生时刻；非取消终态为 undefined。 */
  readonly cancelledAt?: number | undefined
  /** 取消归属；非取消终态为 undefined。 */
  readonly cancelledBy?: SessionRunCancelledBy | undefined
  /** 失败原因文本；非失败终态为 undefined。 */
  readonly error?: string | undefined
  /** 运行开始时刻（epoch 毫秒）。 */
  readonly startedAt: number
  /** 运行结束时刻（epoch 毫秒）；仍在运行时为 null。 */
  readonly endedAt: number | null
  /** 系统提示词 + 工具目录快照；未记录时为 undefined。 */
  readonly header?: AgentJsonValue | undefined
  /** 已追加的事实序列，按到达顺序。 */
  readonly facts: readonly RunFact[]
  /** 容器写入时的 schema 版本。 */
  readonly schemaVersion: number
}
