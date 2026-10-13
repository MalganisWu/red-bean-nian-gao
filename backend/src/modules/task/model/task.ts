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
  /** 任务唯一标识；身份字段，创建后不变。 */
  readonly taskId: string
  /** 归属用户；所有权校验与按用户查询都以它为准，不可变。 */
  readonly userId: string
  /** 任务所属会话；执行结果最终投递回该会话，不可变。 */
  readonly sessionId: string
  /** 投递到 Agent 的提示词正文；可被用例就地更新。 */
  taskInput: string
  /** 单次任务的计划执行时刻；与 cronExpr 互斥，由 scheduleType 决定用哪个。 */
  runAt?: Date | undefined
  /** 周期任务的 cron 表达式；与 runAt 互斥，由 scheduleType 决定用哪个。 */
  cronExpr: string
  /** 调度类型判别字段：once 走 runAt，recurring 走 cronExpr。 */
  scheduleType: TaskScheduleType
  /** 启停开关；软删除即置 false，调度器只扫 isActive 的任务。 */
  isActive: boolean
  /** 已经历的重试次数；达到策略上限后不再重试。 */
  retryCount: number
  /** 下一次计划执行时刻；周期任务由调度器算出后回写，单次任务可缺省。 */
  nextRunAt?: Date | undefined
}

/**
 * 一次执行的完整记录。`delivered` 是投递确认标记——
 * 投递是 at-least-once，靠它把重复投递收敛成实际一次。
 */
export interface AgentTaskExecution {
  /** 执行记录唯一标识；身份字段，创建后不变。 */
  readonly executionId: string
  /** 所属任务标识；回查任务定义与归属时用它。 */
  readonly taskId: string
  /** 执行时的会话快照；投递按它选队列，即使任务后被改也不受影响。 */
  readonly sessionId: string
  /** 执行状态判别字段；失败原因不在状态里，另存于 errorMessage。 */
  status: TaskExecutionStatus
  /** 计划执行时刻；来自任务 nextRunAt 的快照，不随后续改动而变。 */
  readonly scheduledAt: Date
  /** 实际开始时刻；尚未开始为 undefined。 */
  readonly startedAt?: Date | undefined
  /** 结束时刻；仍在运行或未终结为 undefined。 */
  completedAt?: Date | undefined
  /** 运行期间产生的展示消息快照；投递时原样下发，不重新执行。 */
  readonly displayMessages: readonly DisplayMessage[]
  /** 结果类型标记；无结构化结果为 undefined。 */
  readonly resultType?: string | undefined
  /** 结果正文；透传给用户，无结果为 undefined。 */
  readonly resultMessage?: string | undefined
  /** 失败原因正文；仅失败态有值，供日志与展示。 */
  readonly errorMessage?: string | undefined
  /** 是否已确认投递；投递为 at-least-once，靠此标记把重复投递收敛成一次。 */
  readonly delivered: boolean
}

/** 列表里附带的执行摘要；只带展示需要的字段，不含完整的消息与状态快照。 */
export interface AgentTaskExecutionSummary {
  /** 执行记录唯一标识。 */
  readonly executionId: string
  /** 执行状态；列表据此决定展示哪一组字段。 */
  readonly status: TaskExecutionStatus
  /** 计划执行时刻。 */
  readonly scheduledAt: Date
  /** 实际开始时刻；尚未开始为 undefined。 */
  readonly startedAt?: Date | undefined
  /** 结束时刻；未终结为 undefined。 */
  readonly completedAt?: Date | undefined
  /** 结果正文；无结果为 undefined。 */
  readonly resultMessage?: string | undefined
  /** 失败原因正文；仅失败态有值。 */
  readonly errorMessage?: string | undefined
}

/** 任务列表项：任务定义 + 由列表查询一并取出的会话标题与最近一次执行。 */
export interface AgentTaskListItem extends AgentTaskDefinition {
  /** 会话标题快照；由列表查询一并取出，避免前端为展示再查一次会话。 */
  readonly sessionTitle: string
  /** 最近一次执行摘要；该任务从未执行为 undefined。 */
  readonly latestExecution?: AgentTaskExecutionSummary | undefined
}

/** 单个执行记录的已读/折叠偏好；`collapsedOverride` 为 undefined 表示用户未手动覆盖，由前端按默认规则决定。 */
export interface ExecutionViewState {
  /** 目标执行记录标识；与用户配对构成该偏好的唯一键。 */
  readonly executionId: string
  /** 用户标记已读的时刻；未读为 undefined。 */
  readonly seenAt?: Date | undefined
  /** 用户手动折叠覆盖；undefined 表示未覆盖，由前端按默认规则决定。 */
  readonly collapsedOverride?: boolean | undefined
  /** 本记录最后更新时间；供并发写入判断新旧。 */
  readonly updatedAt?: Date | undefined
}

/** 键集分页结果；`nextCursor` 为空串表示没有下一页。 */
export interface TaskPage<TItem> {
  /** 当前页条目，按游标顺序排列。 */
  readonly items: readonly TItem[]
  /** 下一页游标；空串表示已到末页，没有更多数据。 */
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
