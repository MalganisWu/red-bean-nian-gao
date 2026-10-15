// 会话轨迹的业务域模型（只读审计视图）。
// 与 wire DTO（@red-bean/api-contract 的 trajectory/dto）同形但归业务所有；
// controller 层的 presenter 负责领域 → wire 的纯映射。时间字段一律 epoch 毫秒。

/** 一次 LLM 调用的 token 三段用量；cache 为 null 表示 Provider 未返回 / 未采集。 */
export interface TrajectoryTokenUsage {
  /** 输入（提示）token 数。 */
  readonly input: number
  /** 输出（补全）token 数。 */
  readonly output: number
  /** 缓存命中的输入 token；null 表示 Provider 未返回或该数据未采集。 */
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
  /** 展示用 id；由 run id 与请求序号拼成，同一次投影内稳定。 */
  readonly id: string
  /** 全局稳定序号，与所在 call 记录的序号共用同一序列。 */
  readonly seq: number
  /** 本次尝试使用的模型名；与所属 call 同名，重试换模型时才会不同。 */
  readonly model: string
  /** 第几次尝试（含首次），用于把重试展开成多行。 */
  readonly attempt: string
  /** 本次请求耗时（毫秒）。 */
  readonly durationMs: number
  /** 本次尝试的 token 用量；null 表示未采集到用量。 */
  readonly tokens: TrajectoryTokenUsage | null
  /** 本次尝试的结局；error 时 `error` 字段才有意义。 */
  readonly status: 'success' | 'error'
  /** 失败原因；仅在 status 为 error 时出现。 */
  readonly error?: string | undefined
  /** 本次尝试的开始时刻（epoch 毫秒）。 */
  readonly at: number
}

/**
 * 轮次/会话终态标记。**按触发者区分**：
 * `interrupt` = LLM 主动发起挂起；`cancelled` = 用户主动取消；
 * `crashed` = 进程崩溃遗留。三者不得混用，展示文案由前端映射。
 */
export interface TrajectoryEndState {
  /** 终态种类；区分触发者，详见接口注释。 */
  readonly state: 'completed' | 'failed' | 'cancelled' | 'exhausted' | 'interrupt' | 'crashed'
  /** 终态发生时刻（epoch 毫秒）；缺精确结束时间时取已落库事实的下界。 */
  readonly at: number
  /** 补充说明（如错误文本）；缺省表示没有附带信息。 */
  readonly note?: string | undefined
}

/** 一条轨迹记录（轮次内一行）。 */
export interface TrajectoryRecord {
  /** 展示用 id；由序号拼成，同一会话重复投影结果稳定。 */
  readonly id: string
  /** 全局稳定序号（展示顺序即序号顺序）。 */
  readonly seq: number
  /** 记录种类，决定前端如何渲染这一行。 */
  readonly kind: TrajectoryRecordKind
  /** 记录发生时刻（epoch 毫秒）；call 取首次尝试的开始时刻而非提交时刻。 */
  readonly at: number
  /** 单行摘要，仅用于列表展示；完整内容另存于 thinking / reply / result。 */
  readonly summary: string
  /** 记录名（工具名、子 Agent 名等）；不适用该种类的记录缺省。 */
  readonly name?: string | undefined
  /** 操作对象（如被读写的资源）；缺省表示没有可展示的目标。 */
  readonly target?: string | undefined
  /** 调用级 token（取最后一次产出用量的 attempt）；G0 为 null（未采集）。 */
  readonly tokens?: TrajectoryTokenUsage | null | undefined
  /** 合计 token（kind=subagent，来自子执行记录）。 */
  readonly totalTokens?: number | undefined
  /** 执行耗时（毫秒）；null 表示时长未采集，与 0 耗时区分。 */
  readonly durationMs?: number | null | undefined
  /** `success`/`error` 为执行结果；`interrupt` LLM 发起挂起；`incomplete` 用户打断。 */
  readonly status?: 'success' | 'error' | 'interrupt' | 'incomplete' | undefined
  /** 子记录（嵌套展示）；缺省表示该记录没有下层明细。 */
  readonly children?: TrajectoryRecord[] | undefined
  /** 本调用的尝试明细；G0 为空（未采集）。 */
  readonly attempts?: TrajectoryAttempt[] | undefined
  /** 审批等待时长（毫秒）：跨 run 重建为一行时由 `闭合.at − 挂起.at` 得出。 */
  readonly waitMs?: number | undefined
  /** 思考文本全文；缺省表示这一步没有思考内容。 */
  readonly thinking?: string | undefined
  /** 助手回复全文；缺省表示这一步没有正文。 */
  readonly reply?: string | undefined
  /** 工具入参的 JSON 文本；缺省表示该记录没有入参。 */
  readonly params?: string | undefined
  /** 工具结果或错误文本；缺省表示没有可展示的结果。 */
  readonly result?: string | undefined
  /** 产出该记录的模型名；不适用该种类的记录缺省。 */
  readonly model?: string | undefined
}

/** 一轮对话（用户消息开轮）。 */
export interface TrajectoryTurn {
  /** 轮次序号（从 1 开始），由投影顺序决定。 */
  readonly turn: number
  /** 本轮开始时刻（epoch 毫秒）；取本轮首条记录的时间。 */
  readonly startedAt: number
  /** 本轮耗时（毫秒）；未终结轮次给出的是已落库活动区间的下界，不是最终耗时。 */
  readonly durationMs: number
  /** 本轮 token 合计（含子 Agent）；G0 主会话未采集时为 null。 */
  readonly tokens: number | null
  /** 补充说明（如错误文本）；缺省表示没有附带信息。 */
  readonly note?: string | undefined
  /** 本轮的全部记录，按发生顺序排列。 */
  readonly records: TrajectoryRecord[]
  /** 本轮终态；null 或缺省表示该轮尚未终结（前端显示为「进行中」）。 */
  readonly endState?: TrajectoryEndState | null | undefined
}

/** 上下文压缩事件（轮次之间的一等公民记录）。 */
export interface TrajectoryCompaction {
  /** 展示用 id；由序号拼成，同一会话重复投影结果稳定。 */
  readonly id: string
  /** 全局稳定序号，与会话内记录共用同一序列。 */
  readonly seq: number
  /** 本次压缩发生在其后的轮次号；压缩是会话级事实，不占用轮次记录位。 */
  readonly afterTurn: number
  /** 压缩发生时刻（epoch 毫秒）。 */
  readonly at: number
  /** 压缩耗时（毫秒）；无可测调用时为 0（事实里保留 null 语义）。 */
  readonly durationMs: number
  /** 压缩前消息估算的 token 数。 */
  readonly beforeTokens: number
  /** 压缩后消息估算的 token 数。 */
  readonly afterTokens: number
  /** 压缩后保留的消息条数。 */
  readonly messages: number
  /** 压缩策略名；缺省表示未记录具体策略。 */
  readonly strategy?: string | undefined
  /** 压缩结局；failed 表示压缩失败，interrupted 表示被取消。 */
  readonly status: 'success' | 'failed' | 'interrupted'
}

/** 会话轨迹完整视图（领域形态）。 */
export interface SessionTrajectory {
  /** 会话 id，本次轨迹的业务归属。 */
  readonly sessionId: string
  /** 会话标题；无可用用户消息时为空串，由 DTO 层决定是否回落占位文案。 */
  readonly title: string
  /** 全部轮次，按开始顺序排列。 */
  readonly turns: readonly TrajectoryTurn[]
  /** 最近一次上下文压缩；DTO 只有单槽，null 表示从未发生压缩。 */
  readonly compaction?: TrajectoryCompaction | null | undefined
  /** 会话终态；null 表示会话仍在进行，不得据此声称已结束。 */
  readonly sessionEnd?: TrajectoryEndState | null | undefined
  /** 主会话累计 token；G0 为 null（未采集）。 */
  readonly totalTokens: number | null
  /** 子 Agent 累计 token。 */
  readonly subAgentTokens: number
  /** 各轮耗时之和（毫秒），反映实际活动时间。 */
  readonly activeMs: number
  /** 首轮开始到末轮结束的墙钟跨度（毫秒），含轮次之间的闲置。 */
  readonly spanMs: number
}
