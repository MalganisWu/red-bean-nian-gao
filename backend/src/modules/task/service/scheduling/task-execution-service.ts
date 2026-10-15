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

/** 重试策略：最大重试次数、重试间隔（毫秒）与 cron 解释所用的时区。 */
export interface ScheduledTaskPolicy {
  /** 最大重试次数；重试计数达到它即判定预算耗尽，进入最终失败分支。 */
  readonly maxRetries: number
  /** 距上次失败的等待间隔（毫秒）；用于算下一次重试的运行时刻。 */
  readonly retryIntervalMilliseconds: number
  /** 解释 cron 表达式所用时区；非法时区在构造期即拒绝。 */
  readonly timezone: string
}

/** 一次定时任务运行的业务身份、时间与 fencing 快照。 */
export interface ScheduledTaskRunState {
  /** 本次执行所依据的任务定义快照。 */
  readonly task: AgentTaskDefinition
  /** 本次执行业务 ID；同时作为 Agent run 的业务标识与执行记录主键。 */
  readonly executionId: string
  /** 链路追踪 ID；透传给 Agent run 与日志，串联一次执行的全程。 */
  readonly traceId: string
  /** 实际开始时刻；作为执行记录的 startedAt 写入。 */
  readonly startedAt: Date
  /** 认领执行权用的围栏令牌；失租后落库写入会被拒绝。 */
  readonly fencingToken: bigint
  /** 失租信号；兑现即表示写入资格已失效，落库前必须据此中断。 */
  readonly leaseLost?: Promise<Error> | undefined
}

/** 服务依赖；仓储按实际用到的方法收窄，`queue` 缺省表示这次装配不投递结果。 */
export interface TaskExecutionServiceOptions {
  /** 任务读取入口；收窄到读取任务定义一个方法。 */
  readonly queries: Pick<TaskQueryRepository, 'getTask'>
  /** 写路径仓储；认领、更新任务与执行落库三个方法。 */
  readonly commands: Pick<
    TaskCommandRepository,
    'claimExecution' | 'updateTask' | 'saveExecutionWithTaskUpdate'
  >
  /** ID 生成器；为本次执行生成带前缀的业务 ID。 */
  readonly idGenerator: IdGenerator
  /** 后台 Agent 执行 Port；run 的核心动作由它承担。 */
  readonly background: BackgroundAgentExecutionPort
  /** 投递入口；缺省表示本次装配不投递结果（如测试或纯执行场景）。 */
  readonly queue: Pick<DeliveryQueue, 'queueDeliverExecution'> | undefined
  /** 重试与 cron 策略。 */
  readonly policy: ScheduledTaskPolicy
  /** 链路追踪器；run 的 span 由它开启与结束。 */
  readonly tracer: Tracer
  /**
   * traceId 工厂；每次执行据此生成链路标识，便于测试注入固定值。
   * @returns 新生成的追踪 ID
   */
  readonly traceIdFactory: () => string
  /**
   * 时钟注入点；缺省用系统时间，测试可注入固定时刻。
   * @returns 当前时刻
   */
  readonly now?: (() => Date) | undefined
}

/** 定时任务的系统提示词；核心是「无人可交互」——不提问、不请求澄清、不碰任务管理工具。 */
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
 * 授权边界与代价见 `docs/design/tool/tool-system.md`。
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
  /** 任务读取入口；重试与成功分支都会重新加载任务以拿最新状态。 */
  readonly #queries: Pick<TaskQueryRepository, 'getTask'>
  /** 写路径仓储；认领、更新任务与执行落库三个方法。 */
  readonly #commands: Pick<
    TaskCommandRepository,
    'claimExecution' | 'updateTask' | 'saveExecutionWithTaskUpdate'
  >
  /** ID 生成器；为本次执行生成业务 ID。 */
  readonly #idGenerator: IdGenerator
  /** 后台 Agent 执行 Port。 */
  readonly #background: BackgroundAgentExecutionPort
  /** 投递入口；undefined 表示本次装配不投递结果。 */
  readonly #queue: Pick<DeliveryQueue, 'queueDeliverExecution'> | undefined
  /** 重试与 cron 策略；构造时已校验合法。 */
  readonly #policy: ScheduledTaskPolicy
  /** 链路追踪器；负责 run 的 span。 */
  readonly #tracer: Tracer
  /**
   * traceId 工厂。
   * @returns 新生成的追踪 ID
   */
  readonly #traceIdFactory: () => string
  /**
   * 时钟注入点；缺省为系统时间。
   * @returns 当前时刻
   */
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

  /**
   * 完整执行一次定时任务：建快照 → 跑 Agent → 落库/重试/投递，全程带 span 与 traceId。
   *
   * @param taskId - 待执行任务标识；运行期会据此重新加载任务状态。
   * @param lease - 调度租约；fencing token 决定本次写入资格，丢失即中断落库。
   * @param signal - 取消信号，通常来自调度器的执行超时与父级取消。
   */
  public async run(taskId: string, lease: ScheduledTaskLease, signal: AbortSignal): Promise<void> {
    const traceId = this.#traceIdFactory()
    const span = this.#tracer.start({
      name: 'scheduler.run',
      attributes: [
        { key: 'trace.id', value: traceId },
        { key: 'task.id', value: taskId },
      ],
    })
    // 在 span 内完成「加载状态 → 执行 Agent → 落库」，并把 Agent 失败向外抛出。
    const executeRun = async (): Promise<void> => {
      const state = await this.#loadRunState(taskId, lease, traceId, signal)
      const outcome = await this.#executeAgent(state, lease, signal)
      await this.#commit(
        state,
        outcome.result,
        outcome.error,
        AbortSignal.timeout(PERSISTENCE_TIMEOUT_MILLISECONDS)
      )
      if (outcome.error !== undefined) throw outcome.error
    }
    try {
      await span.within(executeRun)
      span.end()
    } catch (cause: unknown) {
      const error = normalizeError(cause)
      span.end(error)
      throw error
    }
  }

  /**
   * 快照：加载任务、索取 fencing 并生成执行 ID；凭据不足或竞争失败立即拒绝。
   *
   * @param taskId - 待执行任务标识。
   * @param lease - 调度租约，提供 fencing token 与失租信号。
   * @param traceId - 本次执行的链路 ID，写入快照供后续日志复用。
   * @param signal - 取消信号，透传到库查询与认领。
   * @returns 本次运行的不可变快照。
   */
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

  /**
   * 执行 Agent：单一调用点组装运行选项；结果或异常统一归一化返回，不在本方法抛错。
   *
   * @param state - 本次运行快照，提供身份、输入与回退键。
   * @param lease - 调度租约；其失租信号并入执行信号，失租即中断运行。
   * @param signal - 取消信号，通常来自调度器的执行超时与父级取消。
   * @returns Agent 结果与被归一化的错误，二者按约定互斥地表达成败。
   */
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

  /**
   * 提交结果：lease 未丢失才落库；按成功/可重试失败/最终失败走对应分支，随后投递。
   *
   * @param state - 本次运行快照；落库前据此确认租约仍在。
   * @param result - Agent 结果；undefined 表示执行期抛错，按系统崩溃处理。
   * @param executionError - 被捕获的执行异常；与 result 二者至少一个非空。
   * @param signal - 落库阶段的取消信号，已换为独立的持久化超时预算。
   */
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

  /**
   * 失败分支，两条出路取决于重试预算是否耗尽：
   * - **还有预算**：只更新重试计数与下次运行时间，**不写执行记录**——这一轮不算一次「执行」，
   *   轨迹里不该出现一串只有失败没有结果的记录。同时清掉恢复缓冲，让下次从干净状态开始。
   * - **预算耗尽**：写一条失败执行记录并投递。此时按任务类型分流：
   *   周期任务**把 retryCount 归零**再排下一次 cron——否则它会永远卡在耗尽状态、
   *   每次触发都直接失败；一次性任务则关停。
   *
   * @param state - 本次运行快照；fencing token 用于保护落库写入。
   * @param result - Agent 结果；undefined 表示执行期抛错，展示消息回退为空。
   * @param errorMessage - 归一化后的错误文案，写入执行记录的 errorMessage。
   * @param signal - 落库阶段的取消信号。
   */
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

  /**
   * 成功分支：清空重试计数、按类型安排下次运行或关闭任务，再写执行记录并投递。
   *
   * @param state - 本次运行快照；fencing token 用于保护落库写入。
   * @param result - 成功的 Agent 结果，提供输出与展示消息。
   * @param signal - 落库阶段的取消信号。
   */
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

  /**
   * 原子落库（fencing 保护）+ 清除恢复缓冲；持久化超时由调用方信号约束。
   *
   * @param state - 本次运行快照；fencing token 与租赁检查保护写入。
   * @param task - 与执行同事务更新的任务定义。
   * @param execution - 待写入的执行记录。
   * @param signal - 持久化阶段的取消信号。
   */
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

  /**
   * 组装执行记录：成败两路共用同一字段骨架，只替换状态、展示与消息内容。
   *
   * @param state - 本次运行快照，提供执行 ID、任务与会话归属。
   * @param scheduledAt - 计划执行时刻；取自任务 nextRunAt 快照。
   * @param completedAt - 结束时刻。
   * @param status - 终态；成功为 completed，失败为 failed。
   * @param displayMessages - 该次运行的展示消息快照。
   * @param resultType - 结果类型标记：success 或 error。
   * @param resultMessage - 结果正文，透传给用户。
   * @param errorMessage - 失败原因；仅在失败分支给出。
   * @returns 待落库的执行记录。
   */
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

  /**
   * 投递结果：把本次执行推进会话投递队列；装配时未提供 queue 则静默跳过。
   *
   * @param state - 本次运行快照，提供会话与执行标识。
   * @param signal - 取消信号，透传到投递队列。
   */
  async #deliver(state: ScheduledTaskRunState, signal: AbortSignal): Promise<void> {
    await this.#queue?.queueDeliverExecution(
      state.task.sessionId,
      state.task.taskId,
      state.executionId,
      signal
    )
  }
}

/**
 * Task execution ID 是该次 Agent run 的稳定业务 ID，此映射不得退化为散落字段复制。
 *
 * @param state - 本次运行快照。
 * @returns Agent run 的业务身份；attempt 为已重试次数加一。
 */
function scheduledTaskRunIdentity(state: ScheduledTaskRunState): AgentRunIdentity {
  return {
    runId: state.executionId,
    sessionId: state.task.sessionId,
    userId: state.task.userId,
    traceId: state.traceId,
    attempt: state.task.retryCount + 1,
  }
}

/**
 * 组装本次后台 Agent 运行选项：身份、输入截断与固定系统提示词，
 * 并带上排除工具清单，防止无人值守的执行路径触达交互或命令执行工具。
 *
 * @param state - 本次运行快照。
 * @returns 后台 Agent 执行命令。
 */
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

/**
 * 把失租信号并入执行信号：租约被接管时立即中断本次运行，避免过期实例继续写。
 * 无失租信号时直接返回原信号，不额外建控制器。
 *
 * @param signal - 原执行信号，通常来自调度器的超时与父级取消。
 * @param leaseLost - 租约失租信号；undefined 表示该租约不提供失租通知。
 * @returns 兼受原信号与失租约束的执行信号。
 */
function executionSignal(signal: AbortSignal, leaseLost: Promise<Error> | undefined): AbortSignal {
  if (leaseLost === undefined) return signal
  const controller = new AbortController()
  void leaseLost.then((error): void => controller.abort(error))
  return AbortSignal.any([signal, controller.signal])
}

/**
 * 取出租约的围栏令牌；缺失即抛错——没有 fencing token 就无法保证写入资格，
 * 与其裸奔落库，不如在这里就拒绝。
 *
 * @param lease - 调度租约。
 * @returns 租约的 fencing token。
 */
function requireFencingToken(lease: ScheduledTaskLease): bigint {
  if (lease.fencingToken === undefined) throw new Error('定时任务 lease 缺少 fencing token')
  return lease.fencingToken
}

/**
 * 失败时的展示消息：把失败文案放在最前，**保留**原有的推理与工具组 section 在文案之后。
 * 保留过程是有意的——用户需要看到「它尝试做了什么才失败的」，
 * 只留一句「任务失败」会让排障变成猜谜。只截取 reason/tool_group 两类，去掉会与失败文案冲突的内容 section。
 *
 * @param messages - 本次运行产生的展示消息；从中抽取推理与工具组过程。
 * @param notice - 失败文案，置于展示消息最前。
 * @param timestamp - 消息时间戳来源。
 * @returns 合成的失败展示消息；内容 section 为失败文案，后接保留的过程 section。
 */
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

/**
 * 把 Agent 的结果状态翻译成面向用户的中文失败文案，覆盖全部状态分支。
 *
 * @param status - 结果状态；额外接受 'failed' 表示执行期抛错。
 * @returns 对应的中文说明。
 */
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

/**
 * 算下一次触发时间。`mode: '5-part'` 固定为五位 cron（分 时 日 月 周），
 * 避免库对六位写法的歧义解释。
 *
 * 表达式非法或算不出下次时间时，**兜底为 1 小时后**而不是抛错：
 * 抛错会让这次执行失败、任务卡在「永远不会再触发」的状态；
 * 顺延一小时至少能让它继续被调度，运维还有机会从执行记录里发现问题。
 *
 * @param expression - cron 表达式；非法时回退。
 * @param timezone - 解释表达式所用时区。
 * @param now - 计算基准时刻。
 * @returns 下次触发时刻；表达式非法或算不出时返回 now 之后一小时。
 */
function nextCronRun(expression: string, timezone: string, now: Date): Date {
  try {
    const next = new Cron(expression, { timezone, paused: true, mode: '5-part' }).nextRun(now)
    if (next === null) throw new Error('cron 无下次执行时间')
    return next
  } catch {
    return new Date(now.valueOf() + 60 * 60 * 1_000)
  }
}

/**
 * 落库前确认 lease 仍在手上。
 * `Promise.race([lost, Promise.resolve(undefined)])` 只判断**是否已经丢失**，
 * 不等它将来可能丢失——这个 race 立刻就有结果：丢失的 Promise 已 settle 则拿到 Error，
 * 否则拿到 undefined。若直接 `await state.leaseLost`，一次成功的执行会被永久挂在这里。
 *
 * @param state - 本次运行快照；无失租信号时不做任何校验。
 */
async function assertLeaseHeld(state: ScheduledTaskRunState): Promise<void> {
  if (state.leaseLost === undefined) return
  const lost = await Promise.race([state.leaseLost, Promise.resolve(undefined)])
  if (lost !== undefined) throw new Error('拒绝持久化已丢失 lease 的定时任务', { cause: lost })
}

/**
 * 判定 JSON 值是否为非数组对象，作为读取 section 字段前的窄化闸门。
 *
 * @param value - 待判定的 JSON 值。
 * @returns 为真时 value 可安全按对象索引。
 */
function isJsonObject(value: AgentJsonValue): value is Record<string, AgentJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 组装期校验重试策略：重试次数与间隔必须为正整数，时区必须能被 Intl 解析。
 * 在构造时失败，避免运行期出现「永远重试」或「cron 时区静默错位」这类隐患。
 *
 * @param policy - 待校验的重试与 cron 策略。
 */
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
