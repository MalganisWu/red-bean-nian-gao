import type { DisplayMessage } from './../../agent/public-api.js'

/** Task Domain 自有状态；Wire DTO 由 Presenter 显式映射，禁止反向依赖 API Contract。 */
export type TaskScheduleType = 'once' | 'recurring'
/** 单次执行的状态。失败态不带原因，原因在 `AgentTaskExecution.errorMessage` 里。 */
export type TaskExecutionStatus = 'pending' | 'running' | 'completed' | 'failed'

/**
 * 定时任务定义。可变字段（`taskInput`/`isActive`/`retryCount`/`nextRunAt`）是刻意的：
 * 调度器与用例服务会就地修改这个对象再交给仓储更新，`readonly` 只用在真正不变的身份字段上。
 */
export interface AgentTaskDefinition {
  readonly taskId: string
  readonly userId: string
  readonly sessionId: string
  taskInput: string
  runAt?: Date | undefined
  cronExpr: string
  scheduleType: TaskScheduleType
  isActive: boolean
  retryCount: number
  nextRunAt?: Date | undefined
}

/**
 * 一次执行的完整记录。`delivered` 是投递确认标记——
 * 投递是 at-least-once，靠它把重复投递收敛成实际一次。
 */
export interface AgentTaskExecution {
  readonly executionId: string
  readonly taskId: string
  readonly sessionId: string
  status: TaskExecutionStatus
  readonly scheduledAt: Date
  readonly startedAt?: Date | undefined
  completedAt?: Date | undefined
  readonly displayMessages: readonly DisplayMessage[]
  readonly resultType?: string | undefined
  readonly resultMessage?: string | undefined
  readonly errorMessage?: string | undefined
  readonly delivered: boolean
}

/** 列表里附带的执行摘要；只带展示需要的字段，不含完整的消息与状态快照。 */
export interface AgentTaskExecutionSummary {
  readonly executionId: string
  readonly status: TaskExecutionStatus
  readonly scheduledAt: Date
  readonly startedAt?: Date | undefined
  readonly completedAt?: Date | undefined
  readonly resultMessage?: string | undefined
  readonly errorMessage?: string | undefined
}

/** 任务列表项：任务定义 + 由列表查询一并取出的会话标题与最近一次执行。 */
export interface AgentTaskListItem extends AgentTaskDefinition {
  readonly sessionTitle: string
  readonly latestExecution?: AgentTaskExecutionSummary | undefined
}

/** 单个执行记录的已读/折叠偏好；`collapsedOverride` 为 undefined 表示用户未手动覆盖，由前端按默认规则决定。 */
export interface ExecutionViewState {
  readonly executionId: string
  readonly seenAt?: Date | undefined
  readonly collapsedOverride?: boolean | undefined
  readonly updatedAt?: Date | undefined
}

/** 键集分页结果；`nextCursor` 为空串表示没有下一页。 */
export interface TaskPage<TItem> {
  readonly items: readonly TItem[]
  readonly nextCursor: string
}

/** 仓储层失败的稳定错误码；用例层据此映射成面向用户的错误（见 `task-application-error.ts`）。 */
export const TASK_REPOSITORY_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'task_not_found',
  NOT_AUTHORIZED: 'task_not_authorized',
  STALE_EXECUTION: 'task_stale_execution',
} as const)

/** 仓储错误码的字面量联合。 */
export type TaskRepositoryErrorCode =
  (typeof TASK_REPOSITORY_ERROR_CODES)[keyof typeof TASK_REPOSITORY_ERROR_CODES]

/** 仓储层异常。`code` 是机器判据，`message` 只供日志——对外文案由用例层重新给。 */
export class TaskRepositoryError extends Error {
  /** 机器可判定的失败分类；用例层据它决定映射与重试，不靠 message 文本。 */
  public readonly code: TaskRepositoryErrorCode

  public constructor(code: TaskRepositoryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'TaskRepositoryError'
    this.code = code
  }
}
