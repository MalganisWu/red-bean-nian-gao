import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'

/**
 * 面向展示的一条消息，也是落库快照的形状。
 * `role` 是自由字符串而非对话角色联合：同一条记录既承载 assistant/user 正文，
 * 也承载工具结果与分节内容，由 `source` 与 `sections` 区分来源。
 */
export interface DisplayMessage {
  readonly role: string
  readonly content?: string
  readonly cards?: readonly Card[]
  readonly sections?: AgentJsonValue
  readonly source?: string
  readonly meta?: MessageMeta
  readonly timestamp: number
}

/** 展示元信息；目前承载定时任务来源与本次运行开始时间。 */
export interface MessageMeta {
  readonly scheduledTask?: ScheduledTaskMeta
  readonly runStartedAt?: number
}

/** 消息由定时任务产生时的来源信息；`status` 是任务执行的状态，不是消息本身的状态。 */
export interface ScheduledTaskMeta {
  readonly taskId: string
  readonly taskName: string
  readonly status: string
  readonly executionId: string
  readonly scheduledAt: number
  readonly completedAt: number
}

/** 交互卡片；`data` 的形状由 `type` 决定，后端只做搬运与透传，不解释其内容。 */
export interface Card {
  readonly type: string
  readonly data: AgentJsonObject
}

/**
 * 分节内容项：展示层的一个分组/折叠单元。
 * 载荷字段（`items`/`tools`/`card`）都可选，用哪个由 `type` 决定；`duration` 只对有耗时的分节有意义。
 */
export interface SectionItem {
  readonly type: string
  readonly content?: string
  readonly items?: AgentJsonValue
  readonly tools?: AgentJsonValue
  readonly card?: AgentJsonValue
  readonly timestamp: number
  readonly duration?: number
}

/** 工具调用在展示层的投影；`error` 有值即失败，此时 `result` 通常为空。 */
export interface ToolItem {
  readonly callId: string
  readonly name: string
  readonly status: string
  readonly result?: string
  readonly error?: string
  readonly duration?: number
}
