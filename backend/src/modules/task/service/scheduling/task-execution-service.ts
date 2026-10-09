import type { IdGenerator } from './../../../../shared/id/id-generator.js'
import type { Tracer } from './../../../../platform/observability/public-api.js'
import type {
  AgentRunIdentity,
  BackgroundAgentExecutionCommand,
  BackgroundAgentExecutionPort,
  BackgroundAgentExecutionResult,
  AgentJsonValue,
  DisplayMessage,
} from './../../../agent/public-api.js'
import type { TaskCommandRepository } from './../persistence/command/port/task-command-repository.port.js'
import type { TaskQueryRepository } from './../persistence/query/port/task-query-repository.port.js'
import type { AgentTaskDefinition, AgentTaskExecution } from './../../model/task.js'
import type { ScheduledTaskLease } from './port/task-scheduler.port.js'
import type { DeliveryQueue } from './../delivery/default-task-delivery-service.js'
import { Cron } from 'croner'
import { normalizeError } from './../../../../shared/errors/normalize-error.js'
import { truncateCodePoints } from './../../../../shared/text/truncate-code-points.js'
import {
  MAX_TASK_INPUT_LENGTH,
  SCHEDULED_TASK_MANAGE_TOOL_NAME,
} from './../tool/task-tool-constants.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

export interface ScheduledTaskPolicy {
  readonly maxRetries: number
  readonly retryIntervalMilliseconds: number
  readonly timezone: string
}

/** 一次定时任务运行的业务身份、时间与 fencing 快照。 */
export interface ScheduledTaskRunState {
  readonly task: AgentTaskDefinition
  readonly executionId: string
  readonly traceId: string
  readonly startedAt: Date
  readonly fencingToken: bigint
  readonly leaseLost?: Promise<Error> | undefined
}

export interface TaskExecutionServiceOptions {
  readonly queries: Pick<TaskQueryRepository, 'getTask'>
  readonly commands: Pick<
    TaskCommandRepository,
    'claimExecution' | 'updateTask' | 'saveExecutionWithTaskUpdate'
  >
  readonly idGenerator: IdGenerator
  readonly background: BackgroundAgentExecutionPort
  readonly queue: Pick<DeliveryQueue, 'queueDeliverExecution'> | undefined
  readonly policy: ScheduledTaskPolicy
  readonly tracer: Tracer
  readonly traceIdFactory: () => string
  readonly now?: (() => Date) | undefined
}

export const SCHEDULED_TASK_SYSTEM_PROMPT = `你是定时任务执行器。定时任务已在后台触发，你当前正在执行该任务。

职责：
- 直接执行并完成任务内容（task_input），把结果或提醒清晰、简洁地输出给用户。
- 提醒类任务直接输出提醒内容即可，不要展开、不要反问。

禁止：
- 不要向用户提问，不要请求澄清信息（定时任务无交互对象）。
- 不要调用 sys_ask_user 等交互类工具。
- 不要创建、修改、暂停或删除任何定时任务。`

/**
 * 定时任务运行在无人观察的后台，排除项因此不只有交互类工具：
 * `sys_ask_user` 无人可问，`sys_scheduled_task_manage` 防止任务自我复制，
 * `sys_shell` 是任意命令执行——继承它等于开出一条无人值守的命令执行路径。
 * 决策与代价见 `docs/decisions/2026-10-08-scheduled-task-shell-exclusion.md`。
 */
const EXCLUDED_TASK_TOOL_NAMES = [
  'sys_ask_user',
  SCHEDULED_TASK_MANAGE_TOOL_NAME,
  'sys_shell',
] as const
/** 落库与投递阶段与执行解耦的独立超时，避免持久化故障拖住调度器太久。 */
const PERSISTENCE_TIMEOUT_MILLISECONDS = 30_000

/**
 * 定时任务单次执行服务：从运行快照、Agent 执行到落库、重试与投递的完整流程，
 * 全部串联在 run 一个公开方法内，按序调用私有小方法；span 与 traceId 生命周期也由本类负责。
 */
export class TaskExecutionService {
  readonly #queries: Pick<TaskQueryRepository, 'getTask'>
  readonly #commands: Pick<
    TaskCommandRepository,
    'claimExecution' | 'updateTask' | 'saveExecutionWithTaskUpdate'
  >
  readonly #idGenerator: IdGenerator
  readonly #background: BackgroundAgentExecutionPort
  readonly #queue: Pick<DeliveryQueue, 'queueDeliverExecution'> | undefined
  readonly #policy: ScheduledTaskPolicy
  readonly #tracer: Tracer
  readonly #traceIdFactory: () => string
  readonly #now: () => Date

  public constructor(options: TaskExecutionServiceOptions) {
    validatePolicy(options.policy)
    this.#queries = options.queries
    this.#commands = options.commands
    this.#idGenerator = options.idGenerator
    this.#background = options.background
    this.#queue = options.queue
    this.#policy = options.policy
    this.#tracer = options.tracer
    this.#traceIdFactory = options.traceIdFactory
    this.#now = options.now ?? ((): Date => new Date())
  }

  /** 完整执行一次定时任务：建快照 → 跑 Agent → 落库/重试/投递，全程带 span 与 traceId。 */
  public async run(taskId: string, lease: ScheduledTaskLease, signal: AbortSignal): Promise<void> {
    const traceId = this.#traceIdFactory()
    const span = this.#tracer.start({
      name: 'scheduler.run',
      attributes: [
        { key: 'trace.id', value: traceId },
        { key: 'task.id', value: taskId },
      ],
    })
    try {
      await span.within(async (): Promise<void> => {
        const state = await this.#loadRunState(taskId, lease, traceId, signal)
        const outcome = await this.#executeAgent(state, lease, signal)
        await this.#commit(
          state,
          outcome.result,
          outcome.error,
          AbortSignal.timeout(PERSISTENCE_TIMEOUT_MILLISECONDS)
        )
        if (outcome.error !== undefined) throw outcome.error
      })
      span.end()
    } catch (cause: unknown) {
      const error = normalizeError(cause)
      span.end(error)
      throw error
    }
  }

  /** 快照：加载任务、索取 fencing 并生成执行 ID；凭据不足或竞争失败立即拒绝。 */
  async #loadRunState(
    taskId: string,
    lease: ScheduledTaskLease,
    traceId: string,
    signal: AbortSignal
  ): Promise<ScheduledTaskRunState> {
    const task = await this.#queries.getTask(taskId, signal)
    const fencingToken = requireFencingToken(lease)
    await this.#commands.claimExecution(taskId, fencingToken, signal)
    return {
      task,
      executionId: this.#idGenerator.generate('TAEX'),
      traceId,
      startedAt: this.#now(),
      fencingToken,
      ...optionalField('leaseLost', lease.lost),
    }
  }

  /** 执行 Agent：单一调用点组装运行选项；结果或异常统一归一化返回，不在本方法抛错。 */
  async #executeAgent(
    state: ScheduledTaskRunState,
    lease: ScheduledTaskLease,
    signal: AbortSignal
  ): Promise<{
    readonly result: BackgroundAgentExecutionResult | undefined
    readonly error: Error | undefined
  }> {
    try {
      const result = await this.#background.execute(
        buildRunOptions(state),
        executionSignal(signal, lease.lost)
      )
      return { result, error: result.error }
    } catch (cause: unknown) {
      return { result: undefined, error: normalizeError(cause) }
    }
  }

  /** 提交结果：lease 未丢失才落库；按成功/可重试失败/最终失败走对应分支，随后投递。 */
  async #commit(
    state: ScheduledTaskRunState,
    result: BackgroundAgentExecutionResult | undefined,
    executionError: Error | undefined,
    signal: AbortSignal
  ): Promise<void> {
    await assertLeaseHeld(state)
    if (executionError !== undefined || result === undefined) {
      await this.#handleFailure(
        state,
        result,
        `系统崩溃: ${executionError?.message ?? 'unknown'}`,
        signal
      )
      return
    }
    if (result.status !== 'completed') {
      await this.#handleFailure(
        state,
        result,
        `任务失败: ${translateFailureStatus(result.status)}`,
        signal
      )
      return
    }
    await this.#handleSuccess(state, result, signal)
  }

  /** 失败分支：未耗尽重试则顺延下次运行；否则写失败执行记录并结束任务。 */
  async #handleFailure(
    state: ScheduledTaskRunState,
    result: BackgroundAgentExecutionResult | undefined,
    errorMessage: string,
    signal: AbortSignal
  ): Promise<void> {
    const task = await this.#queries.getTask(state.task.taskId, signal)
    const scheduledAt = task.nextRunAt ?? this.#now()
    task.retryCount += 1
    if (task.retryCount < this.#policy.maxRetries) {
      task.nextRunAt = new Date(this.#now().valueOf() + this.#policy.retryIntervalMilliseconds)
      await assertLeaseHeld(state)
      await this.#commands.updateTask(task, signal, state.fencingToken)
      await this.#background.clearRecovery(state.task.taskId, signal)
      return
    }
    const notice = `任务执行失败：${translateFailureStatus(result?.status ?? 'failed')}，已自动重试 ${String(task.retryCount)} 次`
    if (task.scheduleType === 'recurring') {
      task.retryCount = 0
      task.nextRunAt = nextCronRun(task.cronExpr, this.#policy.timezone, this.#now())
    } else {
      task.isActive = false
    }
    const completedAt = this.#now()
    const execution = this.#buildExecution(
      state,
      scheduledAt,
      completedAt,
      'failed',
      [failureDisplayMessage(result?.displayMessages ?? [], notice, completedAt)],
      'error',
      notice,
      errorMessage
    )
    await this.#commitExecutionWithUpdate(state, task, execution, signal)
    await this.#deliver(state, signal)
  }

  /** 成功分支：清空重试计数、按类型安排下次运行或关闭任务，再写执行记录并投递。 */
  async #handleSuccess(
    state: ScheduledTaskRunState,
    result: BackgroundAgentExecutionResult,
    signal: AbortSignal
  ): Promise<void> {
    const task = await this.#queries.getTask(state.task.taskId, signal)
    const scheduledAt = task.nextRunAt ?? this.#now()
    task.retryCount = 0
    if (task.scheduleType === 'recurring') {
      task.nextRunAt = nextCronRun(task.cronExpr, this.#policy.timezone, this.#now())
    } else {
      task.isActive = false
    }
    const completedAt = this.#now()
    const execution = this.#buildExecution(
      state,
      scheduledAt,
      completedAt,
      'completed',
      structuredClone(result.displayMessages),
      'success',
      result.output
    )
    await this.#commitExecutionWithUpdate(state, task, execution, signal)
    await this.#deliver(state, signal)
  }

  /** 原子落库（fencing 保护）+ 清除恢复缓冲；持久化超时由调用方信号约束。 */
  async #commitExecutionWithUpdate(
    state: ScheduledTaskRunState,
    task: AgentTaskDefinition,
    execution: AgentTaskExecution,
    signal: AbortSignal
  ): Promise<void> {
    await assertLeaseHeld(state)
    await this.#commands.saveExecutionWithTaskUpdate(task, execution, signal, state.fencingToken)
    await this.#background.clearRecovery(state.task.taskId, signal)
  }

  /** 组装执行记录：成败两路共用同一字段骨架，只替换状态、展示与消息内容。 */
  #buildExecution(
    state: ScheduledTaskRunState,
    scheduledAt: Date,
    completedAt: Date,
    status: 'completed' | 'failed',
    displayMessages: readonly DisplayMessage[],
    resultType: 'success' | 'error',
    resultMessage: string,
    errorMessage?: string
  ): AgentTaskExecution {
    return {
      executionId: state.executionId,
      taskId: state.task.taskId,
      sessionId: state.task.sessionId,
      status,
      scheduledAt,
      startedAt: state.startedAt,
      completedAt,
      displayMessages,
      resultType,
      resultMessage,
      ...optionalField('errorMessage', errorMessage),
      delivered: false,
    }
  }

  async #deliver(state: ScheduledTaskRunState, signal: AbortSignal): Promise<void> {
    await this.#queue?.queueDeliverExecution(
      state.task.sessionId,
      state.task.taskId,
      state.executionId,
      signal
    )
  }
}

/** Task execution ID 是该次 Agent run 的稳定业务 ID，此映射不得退化为散落字段复制。 */
function scheduledTaskRunIdentity(state: ScheduledTaskRunState): AgentRunIdentity {
  return {
    runId: state.executionId,
    sessionId: state.task.sessionId,
    userId: state.task.userId,
    traceId: state.traceId,
    attempt: state.task.retryCount + 1,
  }
}

/** 组装本次后台 Agent 运行选项：身份、输入截断与固定系统提示词。 */
function buildRunOptions(state: ScheduledTaskRunState): BackgroundAgentExecutionCommand {
  return {
    ...scheduledTaskRunIdentity(state),
    agentId: 'default',
    recoveryKey: state.task.taskId,
    input: truncateCodePoints(state.task.taskInput, MAX_TASK_INPUT_LENGTH),
    systemPromptAppendix: SCHEDULED_TASK_SYSTEM_PROMPT,
    excludedToolNames: EXCLUDED_TASK_TOOL_NAMES,
  }
}

function executionSignal(signal: AbortSignal, leaseLost: Promise<Error> | undefined): AbortSignal {
  if (leaseLost === undefined) return signal
  const controller = new AbortController()
  void leaseLost.then((error): void => controller.abort(error))
  return AbortSignal.any([signal, controller.signal])
}

function requireFencingToken(lease: ScheduledTaskLease): bigint {
  if (lease.fencingToken === undefined) throw new Error('定时任务 lease 缺少 fencing token')
  return lease.fencingToken
}

function failureDisplayMessage(
  messages: readonly DisplayMessage[],
  notice: string,
  timestamp: Date
): DisplayMessage {
  const process = messages.flatMap((message): readonly AgentJsonValue[] =>
    Array.isArray(message.sections)
      ? message.sections.filter(
          (section): section is Record<string, AgentJsonValue> =>
            isJsonObject(section) &&
            (section['type'] === 'reason' || section['type'] === 'tool_group')
        )
      : []
  )
  return {
    role: 'assistant',
    sections: [{ type: 'content', content: notice, timestamp: timestamp.valueOf() }, ...process],
    timestamp: timestamp.valueOf(),
  }
}

function translateFailureStatus(
  status: BackgroundAgentExecutionResult['status'] | 'failed'
): string {
  switch (status) {
    case 'exhausted':
      return '任务在限定步骤内未能完成'
    case 'cancelled':
      return '任务已取消'
    case 'suspended':
      return '任务等待用户输入'
    case 'completed':
      return '任务已完成'
    case 'failed':
      return 'AI 服务暂时不可用（LLM 调用失败）'
  }
}

function nextCronRun(expression: string, timezone: string, now: Date): Date {
  try {
    const next = new Cron(expression, { timezone, paused: true, mode: '5-part' }).nextRun(now)
    if (next === null) throw new Error('cron 无下次执行时间')
    return next
  } catch {
    return new Date(now.valueOf() + 60 * 60 * 1_000)
  }
}

async function assertLeaseHeld(state: ScheduledTaskRunState): Promise<void> {
  if (state.leaseLost === undefined) return
  const lost = await Promise.race([state.leaseLost, Promise.resolve(undefined)])
  if (lost !== undefined) throw new Error('拒绝持久化已丢失 lease 的定时任务', { cause: lost })
}

function isJsonObject(value: AgentJsonValue): value is Record<string, AgentJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validatePolicy(policy: ScheduledTaskPolicy): void {
  if (!Number.isSafeInteger(policy.maxRetries) || policy.maxRetries <= 0)
    throw new Error('最大重试次数必须大于 0')
  if (
    !Number.isSafeInteger(policy.retryIntervalMilliseconds) ||
    policy.retryIntervalMilliseconds <= 0
  ) {
    throw new Error('重试间隔必须大于 0')
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: policy.timezone })
  } catch {
    throw new Error('时区未设置')
  }
}
