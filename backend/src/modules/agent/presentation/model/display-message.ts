import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'

/**
 * 面向展示的一条消息，也是落库快照的形状。
 * `role` 是自由字符串而非对话角色联合：同一条记录既承载 assistant/user 正文，
 * 也承载工具结果与分节内容，由 `source` 与 `sections` 区分来源。
 */
export interface DisplayMessage {
  /** 消息角色（assistant / user 等）；与 `source`/`sections` 一起决定呈现方式。 */
  readonly role: string
  /** 消息正文；缺省表示该消息只靠 sections/cards 呈现。 */
  readonly content?: string
  /** 交互卡片列表；缺省表示本条消息不含卡片。 */
  readonly cards?: readonly Card[]
  /** 分节内容；刷新页面重放时间线的数据源，缺省表示无分节。 */
  readonly sections?: AgentJsonValue
  /** 来源标识；用来区分普通对话、工具结果与分节内容等不同产出。 */
  readonly source?: string
  /** 展示元信息（定时任务来源、运行开始时间等）；缺省表示无附加元信息。 */
  readonly meta?: MessageMeta
  /** 消息生成时间戳（epoch 毫秒）；用于展示排序。 */
  readonly timestamp: number
}

/** 展示元信息；目前承载定时任务来源与本次运行开始时间。 */
export interface MessageMeta {
  /** 定时任务来源信息；仅由定时任务产生的消息携带。 */
  readonly scheduledTask?: ScheduledTaskMeta
  /** 本次运行开始时间（epoch 毫秒）；用于把消息归入同一次运行。 */
  readonly runStartedAt?: number
}

/** 消息由定时任务产生时的来源信息；`status` 是任务执行的状态，不是消息本身的状态。 */
export interface ScheduledTaskMeta {
  /** 定时任务主键。 */
  readonly taskId: string
  /** 定时任务展示名。 */
  readonly taskName: string
  /** 任务执行状态；描述调度结果而非消息内容。 */
  readonly status: string
  /** 本次执行的标识；外部回合写入时用它识别重复投递。 */
  readonly executionId: string
  /** 计划触发时间（epoch 毫秒）。 */
  readonly scheduledAt: number
  /** 实际完成时间（epoch 毫秒）。 */
  readonly completedAt: number
}

/** 交互卡片；`data` 的形状由 `type` 决定，后端只做搬运与透传，不解释其内容。 */
export interface Card {
  /** 卡片类型；决定 `data` 的结构。 */
  readonly type: string
  /** 卡片数据；结构由 `type` 决定，后端不解释其内容。 */
  readonly data: AgentJsonObject
}

/**
 * 分节内容项：展示层的一个分组/折叠单元。
 * 载荷字段（`items`/`tools`/`card`）都可选，用哪个由 `type` 决定；`duration` 只对有耗时的分节有意义。
 */
export interface SectionItem {
  /** 分节类型（content / reason / tool_group / card 等）；决定用哪个载荷字段。 */
  readonly type: string
  /** 正文类分节的文本；仅 content 类分节使用。 */
  readonly content?: string
  /** 推理类分节的 step 项序列；仅 reason 类分节使用。 */
  readonly items?: AgentJsonValue
  /** 工具组类分节的工具项序列；仅 tool_group 类分节使用。 */
  readonly tools?: AgentJsonValue
  /** 卡片类分节的卡片数据；仅 card 类分节使用。 */
  readonly card?: AgentJsonValue
  /** 分节生成时间戳（epoch 毫秒）。 */
  readonly timestamp: number
  /** 分节耗时（毫秒）；只对有耗时的分节有意义。 */
  readonly duration?: number
}

/** 工具调用在展示层的投影；`error` 有值即失败，此时 `result` 通常为空。 */
export interface ToolItem {
  /** 本次工具调用的标识；与发起它的 assistant 消息对应。 */
  readonly callId: string
  /** 工具名。 */
  readonly name: string
  /** 工具执行状态（running / success / failed 等）。 */
  readonly status: string
  /** 工具成功时的结果正文；失败时通常为空。 */
  readonly result?: string
  /** 工具失败时的错误信息；有值即表示该次调用失败。 */
  readonly error?: string
  /** 工具执行耗时（毫秒）。 */
  readonly duration?: number
}
