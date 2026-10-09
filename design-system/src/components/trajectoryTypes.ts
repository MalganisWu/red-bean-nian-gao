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
  id: string
  /** 全局稳定序号（加载期分配）。 */
  seq?: number
  model: string
  /** 尝试序，如 '2/3'。 */
  attempt: string
  durationMs: number
  /** 成功请求的 token 三段；失败请求缺省。 */
  tokens?: TrajectoryTokenUsage
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
  state: TrajectoryEndStateValue
  /** 结束时刻 HH:MM:SS。 */
  at: string
  /** 附注（如「1 个工具失败，已降级恢复」）。 */
  note?: string
  seq?: number
}

/**
 * 记录状态。`success` / `error` 为执行结果；`running` 为流式进行中（只有开始标记，不虚构耗时）；
 * `interrupt` = LLM 发起挂起（等审批）；`incomplete` = 用户打断、没有结果。
 */
export type TrajectoryRecordStatus = 'success' | 'error' | 'running' | 'interrupt' | 'incomplete'

/** 步骤级 token 用量（三段：输入 / 输出 / 缓存命中）。 */
export interface TrajectoryTokenUsage {
  input: number
  output: number
  cache: number
}

/** 一条轨迹记录（轮次内的一行）。 */
export interface TrajectoryRecord {
  /** 稳定 id，选中态与泳道联动依赖它。 */
  id: string
  /** 全局稳定序号 #N（消费方在加载期按展示顺序分配；折叠/过滤不改变）。 */
  seq?: number
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
  reply?: string
  params?: string
  result?: string
  model?: string
}

/** 一轮对话（用户消息开轮，到下一轮用户消息前结束）。 */
export interface TrajectoryTurn {
  turn: number
  /** 轮次开始时刻，HH:MM:SS。 */
  startedAt: string
  durationMs: number
  /** 本轮 token 合计（含子 Agent）；null = 未采集（显示占位「—」，不虚构）。 */
  tokens: number | null
  /** 轮次备注（如「压缩后上下文 8,100 tok 起」）。 */
  note?: string
  /** 轮次终态标记；有值则记录表尾部渲染一条 turn-end 行。 */
  endState?: TrajectoryTurnEnd
  records: TrajectoryRecord[]
}

/** 轮次间的空档（等待用户输入 / 会话空闲）。 */
export interface TrajectoryGap {
  /** 空档秒数。 */
  seconds: number
  from: string
  to: string
  label: string
}

/** 上下文压缩事件（轮次之间的一等公民记录）。 */
export interface TrajectoryCompaction {
  id: string
  /** 全局稳定序号。 */
  seq?: number
  /** 发生在第几轮之后。 */
  afterTurn: number
  at: string
  durationMs: number
  beforeTokens: number
  afterTokens: number
  /** 被总结的消息条数。 */
  messages: number
  strategy?: string
  /** 压缩终态；失败/中断时上下文未收缩，后续请求输入会异常跳涨，审计必须可辨。 */
  status?: 'success' | 'failed' | 'interrupted'
}

/** 会话结束标记（可选，渲染在记录表尾部）。 */
export interface TrajectorySessionEnd {
  at: string
  state: TrajectoryEndStateValue
  seq?: number
}

/**
 * 终态标识 → 展示文案。wire 只带机制值（按触发者分类），文案在展示边界补——
 * `interrupt` 是 LLM 发起挂起，**不是**中断；`crashed` 才是进程遗留。
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
 */
export function hasPrecedingCall(records: readonly TrajectoryRecord[], index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    const kind = records[i]?.kind
    if (kind === 'call') return true
    if (kind === 'user') return false
  }
  return false
}

/** 毫秒耗时的人类可读格式：>= 1s 显示 x.x s，否则 xxx ms；undefined 显示占位 —。 */
export function formatTrajectoryDuration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`
  return `${ms} ms`
}

/** 秒数间隔的人类可读格式：3 m 24 s / 48 s。 */
export function formatTrajectoryGap(seconds: number): string {
  const sec = Math.round(seconds)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m ? `${m} m ${String(s).padStart(2, '0')} s` : `${s} s`
}

/** token 数量的千分位格式。 */
export function formatTrajectoryTokens(n: number): string {
  return n.toLocaleString('en-US')
}

/** HH:MM:SS → 当天秒数（用于时序定位的相对计算）。 */
export function trajectoryTimeToSeconds(t: string): number {
  const [h = 0, m = 0, s = 0] = t.split(':').map(Number)
  return h * 3600 + m * 60 + s
}
