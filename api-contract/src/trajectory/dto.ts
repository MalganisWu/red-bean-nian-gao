// 会话轨迹域的 wire DTO。只放纯数据类型；运行时校验在同域 schema.ts。
// 时间字段一律 epoch 毫秒（number），展示格式化归前端。
// G0 说明：调用 token（tokens）、尝试明细（attempts）、轮次终态（endState）允许为 null，
// 表示"未采集"——前端据此显示占位而非虚构。

/** 一次 LLM 调用的 token 三段用量。 */
export interface TrajectoryTokenUsageDto {
  /** 输入 token 数（含系统提示与上下文）。 */
  readonly input: number
  /** 输出 token 数（模型生成的补全）。 */
  readonly output: number
  /** 缓存命中；null = Provider 未返回 / 未采集。 */
  readonly cache: number | null
}

/**
 * 轨迹记录类型。`call` 是一条 assistant 事实（一次 LLM 调用，含全部 attempt）；
 * `tool` 为工具调用（审批的挂起与闭合按 callId 在投影层重建为一条）；终态标记另计。
 *
 * 不设 `step` / `request`：前者是投影期数出来的展示序号，后者是 call 的尝试明细
 * （见 `TrajectoryAttemptDto`）——两者都不是独立记录类型。
 */
export type TrajectoryRecordKindDto =
  'user' | 'call' | 'tool' | 'subagent' | 'turn-end' | 'session-end'

/** 一次实际 LLM 请求（call 的可展开子行；重试时多条）。 */
export interface TrajectoryAttemptDto {
  /** 尝试记录的稳定 ID。 */
  readonly id: string
  /** 全局稳定序号（展示顺序即序号顺序）。 */
  readonly seq: number
  /** 本次尝试使用的模型标识。 */
  readonly model: string
  /** 尝试序，如 "2/3"。 */
  readonly attempt: string
  /** 本次尝试耗时毫秒。 */
  readonly durationMs: number
  /** 成功请求的用量；失败请求为 null。 */
  readonly tokens: TrajectoryTokenUsageDto | null
  /** 本次尝试的结局：success 成功、error 失败。 */
  readonly status: 'success' | 'error'
  /** 失败原因文本；成功时缺省。 */
  readonly error?: string | undefined
  /** 本次尝试发生的时刻，epoch 毫秒。 */
  readonly at: number
}

/**
 * 轮次/会话终态标记。**按触发者区分**，四个近义值不得混用：
 * `interrupt` = **LLM 主动**发起（模型调用 interrupting 工具 → 挂起等作答）；
 * `cancelled` = **用户主动**取消；`crashed` = **进程**崩溃遗留（run 仍为 RUNNING
 * 且早于本次进程启动）。展示文案（「等待用户」/「已取消」/「已中断」）由前端在展示边界
 * 映射，wire 只带机制值。
 */
export interface TrajectoryEndStateDto {
  /** 终态机制值；取值域见类型注释，展示文案由前端映射。 */
  readonly state: 'completed' | 'failed' | 'cancelled' | 'exhausted' | 'interrupt' | 'crashed'
  /** 进入该终态的时刻，epoch 毫秒。 */
  readonly at: number
  /** 补充说明；缺省表示没有额外备注。 */
  readonly note?: string | undefined
}

/** 一条轨迹记录（轮次内一行）。 */
export interface TrajectoryRecordDto {
  /** 稳定 id（选中态与泳道联动）。 */
  readonly id: string
  /** 全局稳定序号（展示顺序即序号顺序）。 */
  readonly seq: number
  /** 记录类型；决定本行其余可选字段的语义。 */
  readonly kind: TrajectoryRecordKindDto
  /** 绝对时刻（epoch ms）。 */
  readonly at: number
  /** 行摘要（纯文本）。 */
  readonly summary: string
  /** 工具名 / 子 Agent 名。 */
  readonly name?: string | undefined
  /** 工具目标 / 子 Agent 任务简述。 */
  readonly target?: string | undefined
  /** 调用级 token 三段（取最后一次产出用量的 attempt）；G0 为 null（未采集）。 */
  readonly tokens?: TrajectoryTokenUsageDto | null | undefined
  /** 合计 token（kind=subagent，来自子执行记录）。 */
  readonly totalTokens?: number | undefined
  /** 自身耗时毫秒；即时事件为 null。 */
  readonly durationMs?: number | null | undefined
  /**
   * 记录状态。`success` / `error` 为执行结果；`interrupt` = LLM 发起挂起（等审批）；
   * `incomplete` = 用户打断、没有结果。触发者语义与轮次终态一致。
   */
  readonly status?: 'success' | 'error' | 'interrupt' | 'incomplete' | undefined
  /** 子 Agent 的内部工具调用。 */
  readonly children?: TrajectoryRecordDto[] | undefined
  /** 本调用的尝试明细；G0 为空（未采集）。重试时才需要展开。 */
  readonly attempts?: TrajectoryAttemptDto[] | undefined
  /**
   * 审批等待时长（毫秒，kind=tool）：挂起记录与闭合记录跨 run 重建为一行时算出
   * （`闭合.at − 挂起.at`）。与 `durationMs`（工具执行时长）分开表达——等人和跑工具不是同一件事。
   * 未闭合时由前端按当前时刻推算，wire 层不填。
   */
  readonly waitMs?: number | undefined
  /** 检查器详情字段。 */
  readonly thinking?: string | undefined
  /** 模型回复全文；缺省表示该记录不携带回复。 */
  readonly reply?: string | undefined
  /** 入参原样文本；缺省表示该记录不携带入参。 */
  readonly params?: string | undefined
  /** 结果原样文本；缺省表示该记录不携带结果。 */
  readonly result?: string | undefined
  /** 模型标识；缺省表示该记录不关联具体模型。 */
  readonly model?: string | undefined
}

/** 一轮对话（用户消息开轮）。 */
export interface TrajectoryTurnDto {
  /** 轮次序号，从 1 开始。 */
  readonly turn: number
  /** 本轮开始时刻，epoch 毫秒。 */
  readonly startedAt: number
  /** 本轮耗时毫秒。 */
  readonly durationMs: number
  /** 本轮 token 合计（含子 Agent）；G0 主会话未采集时为 null。 */
  readonly tokens: number | null
  /** 轮次备注（如「压缩后上下文 8,100 tok 起」）。 */
  readonly note?: string | undefined
  /** 本轮内的轨迹记录，按序号升序。 */
  readonly records: TrajectoryRecordDto[]
  /** 轮次终态；G0 可由回复存在性推导，不可推导时为 null。 */
  readonly endState?: TrajectoryEndStateDto | null | undefined
}

/** 上下文压缩事件（轮次之间的一等公民记录）。 */
export interface TrajectoryCompactionDto {
  /** 压缩事件的稳定 ID。 */
  readonly id: string
  /** 全局稳定序号（展示顺序即序号顺序）。 */
  readonly seq: number
  /** 发生在第几轮之后。 */
  readonly afterTurn: number
  /** 压缩发生的时刻，epoch 毫秒。 */
  readonly at: number
  /** 压缩耗时毫秒。 */
  readonly durationMs: number
  /** 压缩前的 token 估算值。 */
  readonly beforeTokens: number
  /** 压缩后的 token 估算值。 */
  readonly afterTokens: number
  /** 被总结的消息条数。 */
  readonly messages: number
  /** 压缩策略标识；缺省表示未记录策略。 */
  readonly strategy?: string | undefined
  /** 压缩结果：success 成功、failed 失败、interrupted 被打断。 */
  readonly status: 'success' | 'failed' | 'interrupted'
}

/** 会话轨迹完整视图。 */
export interface SessionTrajectoryDto {
  /** 会话 ID。 */
  readonly sessionId: string
  /** 会话标题。 */
  readonly title: string
  /** 会话内全部轮次，按轮次序号升序。 */
  readonly turns: TrajectoryTurnDto[]
  /** 最近一次压缩事件；null 或缺失表示没有可展示的压缩。 */
  readonly compaction?: TrajectoryCompactionDto | null | undefined
  /** 会话终态；null 或缺失表示会话尚未结束或未采集。 */
  readonly sessionEnd?: TrajectoryEndStateDto | null | undefined
  /** 主会话累计 token；G0 为 null（未采集），子 Agent 合计见 subAgentTokens。 */
  readonly totalTokens: number | null
  /** 子 Agent 累计 token（sub_agent_executions 已落库）。 */
  readonly subAgentTokens: number
  /** 活动耗时合计（毫秒，不含空档）。 */
  readonly activeMs: number
  /** 会话跨度（毫秒，含空档）。 */
  readonly spanMs: number
}
