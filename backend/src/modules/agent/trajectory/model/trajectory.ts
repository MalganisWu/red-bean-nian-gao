/**
 * 会话轨迹的业务域模型（只读审计视图）。
 * 与 wire DTO（@red-bean/api-contract 的 trajectory/dto）同形但归业务所有；
 * controller 层的 presenter 负责领域 → wire 的纯映射。时间字段一律 epoch 毫秒。
 */

/** 一次 LLM 调用的 token 三段用量；cache 为 null 表示 Provider 未返回 / 未采集。 */
export interface TrajectoryTokenUsage {
  readonly input: number
  readonly output: number
  readonly cache: number | null
}

/**
 * 记录类型。`call` 是一条 assistant 事实（一次 LLM 调用，含全部 attempt）；
 * 不设 `step` / `request`——前者是展示序号、后者是 call 的尝试明细（见 TrajectoryAttempt）。
 */
export type TrajectoryRecordKind =
  'user' | 'call' | 'tool' | 'subagent' | 'turn-end' | 'session-end'

/** 一次实际 LLM 请求（call 的可展开子行；重试时多条）。 */
export interface TrajectoryAttempt {
  readonly id: string
  readonly seq: number
  readonly model: string
  readonly attempt: string
  readonly durationMs: number
  readonly tokens: TrajectoryTokenUsage | null
  readonly status: 'success' | 'error'
  readonly error?: string | undefined
  readonly at: number
}

/**
 * 轮次/会话终态标记。**按触发者区分**：
 * `interrupt` = LLM 主动发起挂起；`cancelled` = 用户主动取消；
 * `crashed` = 进程崩溃遗留。三者不得混用，展示文案由前端映射。
 */
export interface TrajectoryEndState {
  readonly state: 'completed' | 'failed' | 'cancelled' | 'exhausted' | 'interrupt' | 'crashed'
  readonly at: number
  readonly note?: string | undefined
}

/** 一条轨迹记录（轮次内一行）。 */
export interface TrajectoryRecord {
  readonly id: string
  /** 全局稳定序号（展示顺序即序号顺序）。 */
  readonly seq: number
  readonly kind: TrajectoryRecordKind
  readonly at: number
  readonly summary: string
  readonly name?: string | undefined
  readonly target?: string | undefined
  /** 调用级 token（取最后一次产出用量的 attempt）；G0 为 null（未采集）。 */
  readonly tokens?: TrajectoryTokenUsage | null | undefined
  /** 合计 token（kind=subagent，来自子执行记录）。 */
  readonly totalTokens?: number | undefined
  readonly durationMs?: number | null | undefined
  /** `success`/`error` 为执行结果；`interrupt` LLM 发起挂起；`incomplete` 用户打断。 */
  readonly status?: 'success' | 'error' | 'interrupt' | 'incomplete' | undefined
  readonly children?: TrajectoryRecord[] | undefined
  /** 本调用的尝试明细；G0 为空（未采集）。 */
  readonly attempts?: TrajectoryAttempt[] | undefined
  /** 审批等待时长（毫秒）：跨 run 重建为一行时由 `闭合.at − 挂起.at` 得出。 */
  readonly waitMs?: number | undefined
  readonly thinking?: string | undefined
  readonly reply?: string | undefined
  readonly params?: string | undefined
  readonly result?: string | undefined
  readonly model?: string | undefined
}

/** 一轮对话（用户消息开轮）。 */
export interface TrajectoryTurn {
  readonly turn: number
  readonly startedAt: number
  readonly durationMs: number
  /** 本轮 token 合计（含子 Agent）；G0 主会话未采集时为 null。 */
  readonly tokens: number | null
  readonly note?: string | undefined
  readonly records: TrajectoryRecord[]
  readonly endState?: TrajectoryEndState | null | undefined
}

/** 上下文压缩事件（轮次之间的一等公民记录）。 */
export interface TrajectoryCompaction {
  readonly id: string
  readonly seq: number
  readonly afterTurn: number
  readonly at: number
  readonly durationMs: number
  readonly beforeTokens: number
  readonly afterTokens: number
  readonly messages: number
  readonly strategy?: string | undefined
  readonly status: 'success' | 'failed' | 'interrupted'
}

/** 会话轨迹完整视图（领域形态）。 */
export interface SessionTrajectory {
  readonly sessionId: string
  readonly title: string
  readonly turns: readonly TrajectoryTurn[]
  readonly compaction?: TrajectoryCompaction | null | undefined
  readonly sessionEnd?: TrajectoryEndState | null | undefined
  /** 主会话累计 token；G0 为 null（未采集）。 */
  readonly totalTokens: number | null
  /** 子 Agent 累计 token。 */
  readonly subAgentTokens: number
  readonly activeMs: number
  readonly spanMs: number
}
