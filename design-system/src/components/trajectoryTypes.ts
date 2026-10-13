/**
 * 会话轨迹组件的纯数据模型（TrajectoryTimeline / TrajectoryLedger / TrajectoryInspector 共享）。
 * 只放纯数据类型；格式化等纯函数工具也收在这里，避免三个组件各自重复。
 */

/**
 * 轨迹记录类型封闭联合：用户消息 / LLM 调用 / 工具调用 / 子 Agent 委派 / 轮次结束 / 会话结束。
 * 压缩是回合间独立事件，见 TrajectoryCompaction。
 *
 * 不设 `step` / `request`：前者是投影期数出来的展示序号，后者是 call 的尝试明细
 * （见 TrajectoryAttempt）——两者都不是独立记录类型，行序本身就表达顺序。
 */
export type TrajectoryRecordKind =
  'user' | 'call' | 'tool' | 'subagent' | 'turn-end' | 'session-end'

/** 一次实际 LLM HTTP 请求（call 的可展开子行；重试时多条）。 */
export interface TrajectoryAttempt {
  /** 尝试的唯一 id（选中态与泳道联动依赖它）。 */
  id: string
  /** 全局稳定序号（加载期分配）。 */
  seq?: number
  /** 本次尝试实际命中的模型名；重试可能在不同模型间切换，故逐条记录而非挂在调用上。 */
  model: string
  /** 尝试序，如 '2/3'。 */
  attempt: string
  /** 本次尝试的实际耗时毫秒；`running` 态为进行中区间，不代表最终值。 */
  durationMs: number
  /** 成功请求的 token 三段；失败请求缺省。 */
  tokens?: TrajectoryTokenUsage
  /** 尝试终态：`success` / `error` 已定稿，`running` 仍在流式进行中（不虚构耗时）。 */
  status: 'success' | 'error' | 'running'
  /** 失败原因（重试触发原因，如「LLM 空响应」）。 */
  error?: string
  /** 时刻继承所属步骤。 */
  at?: string
}

/**
 * 轮次终态。**按触发者区分**：`interrupt` = LLM 主动发起挂起（等用户作答）；
 * `cancelled` = 用户主动取消；`crashed` = 进程崩溃遗留。展示文案由 trajectoryEndStateLabel 映射。
 */
export type TrajectoryEndStateValue =
  'completed' | 'failed' | 'cancelled' | 'exhausted' | 'interrupt' | 'crashed'

/** 轮次终态标记。 */
export interface TrajectoryTurnEnd {
  /** 轮次终态的机制值；展示文案由 trajectoryEndStateLabel 映射，不在此写死。 */
  state: TrajectoryEndStateValue
  /** 结束时刻 HH:MM:SS。 */
  at: string
  /** 附注（如「1 个工具失败，已降级恢复」）。 */
  note?: string
  /** 全局稳定序号；缺省则终态行不显示序号。 */
  seq?: number
}

/**
 * 记录状态。`success` / `error` 为执行结果；`running` 为流式进行中（只有开始标记，不虚构耗时）；
 * `interrupt` = LLM 发起挂起（等审批）；`incomplete` = 用户打断、没有结果。
 */
export type TrajectoryRecordStatus = 'success' | 'error' | 'running' | 'interrupt' | 'incomplete'

/** 步骤级 token 用量（三段：输入 / 输出 / 缓存命中）。 */
export interface TrajectoryTokenUsage {
  /** 输入 token 数。 */
  input: number
  /** 输出 token 数。 */
  output: number
  /** 缓存命中 token 数。 */
  cache: number
}

/** 一条轨迹记录（轮次内的一行）。 */
export interface TrajectoryRecord {
  /** 稳定 id，选中态与泳道联动依赖它。 */
  id: string
  /** 全局稳定序号 #N（消费方在加载期按展示顺序分配；折叠/过滤不改变）。 */
  seq?: number
  /** 记录类型（封闭联合），决定身份 chip、泳道归属与可展开子项。 */
  kind: TrajectoryRecordKind
  /** 绝对时刻，HH:MM:SS。 */
  at: string
  /** 行摘要（纯文本，消费方负责截断）。 */
  summary: string
  /** 工具名 / 子 Agent 名（等宽显示）。 */
  name?: string
  /** 工具目标 / 子 Agent 任务简述。 */
  target?: string
  /** 调用级 token 三段（kind=call）。 */
  tokens?: TrajectoryTokenUsage
  /** 合计 token（kind=subagent，来自子执行记录）。 */
  totalTokens?: number
  /** 自身耗时毫秒；用户消息等即时事件为 undefined。 */
  durationMs?: number
  /** 记录状态；缺省表示该记录类型不带状态语义（如用户消息），消费方按成功档渲染。 */
  status?: TrajectoryRecordStatus
  /** 子 Agent 的内部工具调用（kind=subagent 时可展开）。 */
  children?: TrajectoryRecord[]
  /** 本调用的尝试明细（kind=call；重试时多条，默认展开）。 */
  attempts?: TrajectoryAttempt[]
  /**
   * 审批等待时长毫秒（kind=tool）：挂起与闭合两条事实跨 run 重建为一行时算出。
   * 未闭合时消费方按当前时刻推算；与 durationMs（工具执行时长）分开表达。
   */
  waitMs?: number
  /** 检查器详情字段：思考 / 回复 / 参数 / 结果 / 模型。 */
  thinking?: string
  /** 模型回复正文（kind=call）；未采集时检查器该 tab 不显示内容。 */
  reply?: string
  /** 调用参数原文（工具入参 / JSON 字符串），供审计核对。 */
  params?: string
  /** 执行结果原文（工具输出），失败时可能是错误信息。 */
  result?: string
  /** 记录级模型名；缺省时消费方回落到最后一次尝试携带的模型。 */
  model?: string
}

/** 一轮对话（用户消息开轮，到下一轮用户消息前结束）。 */
export interface TrajectoryTurn {
  /** 轮次序号（从 1 起）；也是折叠状态与间隔推导的键。 */
  turn: number
  /** 轮次开始时刻，HH:MM:SS。 */
  startedAt: string
  /** 轮次耗时毫秒；未终结轮次只是已知活动区间的下界，不是最终耗时。 */
  durationMs: number
  /** 本轮 token 合计（含子 Agent）；null = 未采集（显示占位「—」，不虚构）。 */
  tokens: number | null
  /** 轮次备注（如「压缩后上下文 8,100 tok 起」）。 */
  note?: string
  /** 轮次终态标记；有值则记录表尾部渲染一条 turn-end 行。 */
  endState?: TrajectoryTurnEnd
  /** 本轮按时序排列的扁平记录；层级由消费方按位置推导，wire 上不预分组。 */
  records: TrajectoryRecord[]
}

/** 轮次间的空档（等待用户输入 / 会话空闲）。 */
export interface TrajectoryGap {
  /** 空档秒数。 */
  seconds: number
  /** 空档起点时刻，HH:MM:SS。 */
  from: string
  /** 空档终点时刻，HH:MM:SS。 */
  to: string
  /** 空档性质文案（如「等待用户输入」「会话空闲」），说明这段时间在等什么。 */
  label: string
}

/** 上下文压缩事件（轮次之间的一等公民记录）。 */
export interface TrajectoryCompaction {
  /** 压缩事件唯一 id；与记录共用选中态与泳道联动。 */
  id: string
  /** 全局稳定序号。 */
  seq?: number
  /** 发生在第几轮之后。 */
  afterTurn: number
  /** 压缩发生时刻，HH:MM:SS。 */
  at: string
  /** 压缩本身耗时毫秒（不含随后的等待）。 */
  durationMs: number
  /** 压缩前上下文 token 数，作为缩放的基准。 */
  beforeTokens: number
  /** 压缩后上下文 token 数；失败/中断时可能不小于 beforeTokens。 */
  afterTokens: number
  /** 被总结的消息条数。 */
  messages: number
  /** 压缩策略标识；缺省表示后端未采集，消费方不展示策略名。 */
  strategy?: string
  /** 压缩终态；失败/中断时上下文未收缩，后续请求输入会异常跳涨，审计必须可辨。 */
  status?: 'success' | 'failed' | 'interrupted'
}

/** 会话结束标记（可选，渲染在记录表尾部）。 */
export interface TrajectorySessionEnd {
  /** 会话结束时刻，HH:MM:SS。 */
  at: string
  /** 会话终态的机制值；展示文案由 trajectoryEndStateLabel 映射。 */
  state: TrajectoryEndStateValue
  /** 全局稳定序号；缺省则结束行不显示序号。 */
  seq?: number
}

/**
 * 终态标识 → 展示文案。wire 只带机制值（按触发者分类），文案在展示边界补——
 * `interrupt` 是 LLM 发起挂起，**不是**中断；`crashed` 才是进程遗留。
 *
 * @param state - 后端下发的机制态值（按触发者分类，不含展示文案）。
 * @returns 面向用户的中文终态文案。
 */
export function trajectoryEndStateLabel(state: TrajectoryEndStateValue): string {
  switch (state) {
    case 'completed':
      return '完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    case 'exhausted':
      return '已耗尽'
    case 'interrupt':
      return '等待用户'
    case 'crashed':
      return '已中断'
  }
}

/**
 * 等待时长的人类可读格式：短时用秒、超过一分钟用 m:ss、超过一小时用 h:mm:ss。
 * 长时间等待（如放弃作答的审批）必须紧凑，否则会撑爆记录列。
 *
 * @param ms - 等待时长（毫秒）；负数按 0 处理，避免时钟偏差显示负值。
 * @returns 人类可读的等待时长文案。
 */
export function formatTrajectoryWait(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total} 秒`
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

/**
 * 工具 / 子 Agent 的归属判定：按位置挂在**本轮最近一次 `call`** 之下。
 *
 * 事实日志里工具事实必然排在其所属 assistant 事实之后，而该顺序由 LLM 消息协议保证
 * （assistant 带 tool_calls 的消息必须先于工具结果进入上下文）。
 *
 * 顺序异常时（工具出现在任何 `call` 之前，或先遇到新一轮 `user`）返回 `false`：
 * 降级为「没分组」——根级不缩进；**绝不挂到上一条调用**。分错组比不分组更难发现，
 * 审计视图宁可少表达也不表达错。
 *
 * @param records - 本轮按时序排列的扁平记录。
 * @param index - 待判定记录在 `records` 中的下标。
 * @returns 该记录之前存在尚未被 `user` 截断的 `call` 时为 true；顺序异常时为 false（降级为不分组）。
 */
export function hasPrecedingCall(records: readonly TrajectoryRecord[], index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    const kind = records[i]?.kind
    if (kind === 'call') return true
    if (kind === 'user') return false
  }
  return false
}

/**
 * 毫秒耗时的人类可读格式：>= 1s 显示 x.x s，否则 xxx ms；undefined 显示占位 —。
 *
 * @param ms - 耗时毫秒；undefined 表示未采集（区别于「耗时为零」）。
 * @returns 人类可读的耗时文案；未采集时返回占位「—」，不虚构 0。
 */
export function formatTrajectoryDuration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`
  return `${ms} ms`
}

/**
 * 秒数间隔的人类可读格式：3 m 24 s / 48 s。
 *
 * @param seconds - 空档秒数；按四舍五入取整后格式化。
 * @returns 人类可读的空档文案。
 */
export function formatTrajectoryGap(seconds: number): string {
  const sec = Math.round(seconds)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m ? `${m} m ${String(s).padStart(2, '0')} s` : `${s} s`
}

/**
 * token 数量的千分位格式。
 *
 * @param n - token 数量。
 * @returns 带千分位的字符串（如 `8,100`），便于在窄列中快速比对量级。
 */
export function formatTrajectoryTokens(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * HH:MM:SS → 当天秒数（用于时序定位的相对计算）。
 *
 * @param t - HH:MM:SS 形式的时刻文本；缺字段按 0 计入，避免跨日或残缺输入抛错。
 * @returns 该时刻对应的当天秒数。
 */
export function trajectoryTimeToSeconds(t: string): number {
  const [h = 0, m = 0, s = 0] = t.split(':').map(Number)
  return h * 3600 + m * 60 + s
}
