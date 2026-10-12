import type { AgentJsonObject } from '../../model/json-value.js'

/**
 * 会话事实日志的消息级事实模型（ADR：docs/decisions/2026-09-11-session-trajectory-fact-log.md）。
 * 纯数据类型：不含 parser/serializer；JSON 信任边界的校验在 persistence 层 row mapper。
 * G1 只写 user / assistant / tool 三类；compaction 等会话级事实由 G2 扩展。
 */

/** 事实记录的当前 schema 版本；每条事实落库时都要带上。 */
export const RUN_FACT_SCHEMA_VERSION = 1

/** G1 落库 user / assistant / tool 三类消息级事实；G2 起追加会话级 compaction。 */
export const RUN_FACT_TYPES = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
  COMPACTION: 'compaction',
} as const)

/** 压缩触发来源（与 SSE compaction 事件的 trigger 对齐）。 */
export const RUN_COMPACTION_TRIGGERS = Object.freeze({
  AUTO: 'auto',
  MANUAL: 'manual',
} as const)

/** 压缩触发来源的字面量联合；取值与 SSE compaction 事件的 `trigger` 一致。 */
export type RunCompactionTrigger =
  (typeof RUN_COMPACTION_TRIGGERS)[keyof typeof RUN_COMPACTION_TRIGGERS]

/**
 * 压缩终态。SDK 当前只在成功路径发出 compaction 事件，失败/中断由未来版本的
 * 写入端补充；读取端按三态渲染（压缩失败时上下文未收缩，审计必须可辨）。
 */
export const RUN_COMPACTION_STATUSES = Object.freeze({
  SUCCESS: 'success',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
} as const)

/** 压缩终态的字面量联合；失败态必须可辨——压缩失败意味着上下文并没有收缩。 */
export type RunCompactionStatus =
  (typeof RUN_COMPACTION_STATUSES)[keyof typeof RUN_COMPACTION_STATUSES]

/** 一次 LLM 请求（attempt）的 token 三段用量；缺失维度以 null 表示"未采集"。 */
export interface RunFactUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  /** 缓存命中 token；Provider 不返回时为 null（前端显示 —）。 */
  readonly cacheReadTokens: number | null
}

/** 一次实际 LLM 调用（含重试）：重试从 status(llm_retry) 事件归属为新 attempt。 */
export interface RunFactAttempt {
  readonly attempt: number
  readonly startedAt: number
  readonly endedAt: number
  /** 该次请求的用量；请求失败（未产出 usage）为 null。 */
  readonly usage: RunFactUsage | null
  readonly error?: string | undefined
}

/** 事实记录的公共字段：schema 版本与 ignorable 版本纪律标记。 */
interface RunFactBase {
  readonly schemaVersion: number
  /**
   * ignorable 标记：写入端为"旧读取端可以安全跳过"的记录置 true；
   * 读取端遇到不认识的记录时，带标记跳过、不带标记拒绝重放——事实日志长寿命，
   * 没有自描述必然静默误读。
   */
  readonly ignorable?: true | undefined
}

/** 用户输入事实：content 为用户原文，source 预留给外部注入来源（定时任务等）。 */
export interface RunUserFact extends RunFactBase {
  readonly type: 'user'
  readonly content: string
  readonly source?: string | undefined
  readonly at: number
}

/**
 * 一次 LLM 步骤事实（Agent 循环的一步，通常等于一次请求；发生重试时含多次 attempt）。
 * usage 取步骤内最后一次产出用量的 attempt（即产出最终内容的那次）。
 */
export interface RunAssistantFact extends RunFactBase {
  readonly type: 'assistant'
  readonly at: number
  readonly durationMs: number
  readonly usage: RunFactUsage | null
  readonly attempts: readonly RunFactAttempt[]
  readonly thinking: string
  readonly content: string
}

/**
 * 工具调用的显式状态，**按触发者分类**。只有这两个值无法由 result/error 推断，因此必须显式记：
 * `interrupt` = **LLM 主动**发起（模型调用 interrupting 工具 → 挂起等作答）；
 * `incomplete` = **用户主动**打断（运行终态时工具仍未闭合，没有结果）。
 * 正常完成 / 失败仍由 result / error 推断，不写这个字段。
 */
export const RUN_TOOL_STATUSES = Object.freeze({
  INTERRUPT: 'interrupt',
  INCOMPLETE: 'incomplete',
} as const)

/** 只能显式记录的两种工具状态；正常完成与失败由 `result`/`error` 推断，不写这个字段。 */
export type RunToolStatus = (typeof RUN_TOOL_STATUSES)[keyof typeof RUN_TOOL_STATUSES]

/** 一次工具调用事实：result 与 error 互斥（成功记 result，失败记 error）；status 表达挂起与打断。 */
export interface RunToolFact extends RunFactBase {
  readonly type: 'tool'
  readonly callId: string
  readonly name: string
  readonly params: AgentJsonObject | null
  readonly result?: string | undefined
  readonly error?: string | undefined
  readonly startedAt: number
  readonly durationMs: number
  /** 缺省表示按 result / error 推断为完成或失败（存量记录也没有该字段）。 */
  readonly status?: RunToolStatus | undefined
}

/**
 * 会话级压缩事实（ADR：压缩位于两个 run 之间的会话级记录，随发生时的 run 落在
 * session_runs.facts 序列中）。durationMs 取摘要 LLM 调用时长；首轮压缩等
 * 无可测调用时为 null。status 覆盖 success/failed/interrupted 三态。
 */
export interface RunCompactionFact extends RunFactBase {
  readonly type: 'compaction'
  readonly at: number
  readonly trigger: RunCompactionTrigger
  readonly beforeTokens: number
  readonly afterTokens: number
  /** 被总结的消息条数。 */
  readonly messages: number
  readonly durationMs: number | null
  readonly status: RunCompactionStatus
}

/** 消息级事实与会话级压缩事实的联合。 */
export type RunFact = RunAssistantFact | RunCompactionFact | RunToolFact | RunUserFact
