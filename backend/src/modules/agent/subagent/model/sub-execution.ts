import type { StoredRuntimeState } from '../../execution/model/runtime-state.js'
import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentJsonValue } from '../../model/json-value.js'

/** 子 Agent 执行在产品域中的状态；数据库枚举只由 Repository Adapter 映射。 */
export const SUB_EXECUTION_STATUSES = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  AWAITING_USER: 'awaiting_user',
} as const)

/** 子执行状态的字面量联合；`awaiting_user` 是唯一的中间态，表示在等父 Agent 转达用户作答。 */
export type SubExecutionStatus =
  (typeof SUB_EXECUTION_STATUSES)[keyof typeof SUB_EXECUTION_STATUSES]

/** 子执行仓储的稳定冲突码；两个都是 CAS 类冲突，调用方不得把它降级成普通覆盖写。 */
export const SUB_EXECUTION_STORE_ERROR_CODES = Object.freeze({
  REVISION_CONFLICT: 'sub_execution_revision_conflict',
  RESUME_CONFLICT: 'sub_execution_resume_conflict',
} as const)

/** 冲突码的字面量联合。 */
export type SubExecutionStoreErrorCode =
  (typeof SUB_EXECUTION_STORE_ERROR_CODES)[keyof typeof SUB_EXECUTION_STORE_ERROR_CODES]

/** 子执行持久化的稳定冲突错误，调用方不得把 CAS 失败降级成普通覆盖写。 */
export class SubExecutionStoreError extends Error {
  /** 冲突码；调用方据此区分 revision CAS 冲突与 resume 所有权冲突，不得降级成普通覆盖写。 */
  public readonly code: SubExecutionStoreErrorCode

  public constructor(code: SubExecutionStoreErrorCode, message: string) {
    super(message)
    this.name = 'SubExecutionStoreError'
    this.code = code
  }
}

/** 子 Agent 执行的宿主领域记录，不暴露 PostgreSQL row 命名。 */
export interface SubExecutionRecord {
  /** 子执行标识；仓储主键，也是恢复时定位记录的键。 */
  readonly executionId: string
  /** 所属父会话标识；子执行的结果最终要并回这条会话。 */
  readonly sessionId: string
  /** 发起该子执行的父请求标识；用于串起一次委派的多层调用。 */
  readonly requestId: string
  /** 子 Agent 定义标识；指向被委派的 Agent 配置。 */
  readonly agentId: string
  /** 子 Agent 展示名；写入终态时确定，供父会话渲染分区标题。 */
  agentName: string
  /** 触发本次子执行的用户；所有权校验依据。 */
  readonly userId: string
  /** 委派时的首条用户指令；用于回显「这次让子 Agent 做了什么」。 */
  userMessage: string
  /** 子 Agent 的系统提示词；缺省表示沿用 Agent 定义，不在记录里冗余存储。 */
  systemPrompt?: string | undefined
  /** 落库用的展示载荷；与 `recoveryMessages` 互补，是前端分区的数据源。 */
  display: AgentJsonValue
  /** 合并后的 Runtime 状态；终态写入时更新，恢复时作为续跑起点。 */
  runtimeState?: StoredRuntimeState | undefined
  /** 尚未提交的增量消息；终态写入时清空，避免下次恢复把同一批消息再来一遍。 */
  recoveryMessages: AgentMessage[]
  /** 实际使用的模型名；缺省表示未记录，展示层按未知处理。 */
  modelName?: string | undefined
  /** 本轮累计 token 用量；只做展示与统计，不参与状态判定。 */
  tokensUsed: number
  /** 从创建到完成经过的毫秒数；完成时按 `now - createdAt` 计算并夹到非负。 */
  elapsedMilliseconds: number
  /** 产品域状态；决定父会话如何呈现与是否可续跑。 */
  status: SubExecutionStatus
  /** 等待父 Agent 转达的中断 id；仅 `awaiting_user` 时存在。 */
  pendingInterruptId?: string | undefined
  /** 结果摘要；完成时从最后一条 assistant 正文提取，缺省表示无可用摘要。 */
  resultSummary?: string | undefined
  /** 失败原因；成功与挂起时为 undefined。 */
  errorMessage?: string | undefined
  /** 父会话侧对应的工具调用 id；空串表示非委派场景，不写入记录。 */
  parentCallId?: string | undefined
  /** 记录创建时间；耗时计算的基准，创建后不再变化。 */
  readonly createdAt: Date
  /** 最后更新时间；每次写入刷新。 */
  updatedAt: Date
  /** 进入终态的时间；未完成时缺省。 */
  completedAt?: Date | undefined
  /** 乐观并发版本号；CAS 写回时作为比较基准，冲突即拒绝覆盖。 */
  revision: bigint
}
