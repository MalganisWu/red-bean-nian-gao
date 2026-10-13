import { z } from 'zod'
import { nextRecurring, parseRunAt, validateTimezone } from './scheduled-task-timezone.js'
import { truncateCodePoints } from './../../../../shared/text/truncate-code-points.js'
import { contextualError } from './../error/contextual-error.js'
import { MAX_TASK_INPUT_LENGTH, SCHEDULED_TASK_MANAGE_TOOL_NAME } from './task-tool-constants.js'

import type {
  AgentJsonObject,
  AgentJsonValue,
  AgentTool,
  AgentToolCallContext,
  AgentToolResult,
  AgentToolSchema,
} from './../../../agent/public-api.js'
import type { IdGenerator } from './../../../../shared/id/id-generator.js'

import type { AgentTaskDefinition } from './../../model/task.js'
import type { ScheduledTaskManagementRepositories } from './port/scheduled-task-management-repository.port.js'

/** list 动作最多返回的条数；防止模型一次拉出过多任务撑爆上下文。 */
const MAX_LIST_ITEMS = 20
/** 列表项 task_input 预览的截断长度（码点数）；完整内容留给 get 查看。 */
const PREVIEW_LENGTH = 80

/** 工具入参的运行时校验 schema；所有字段都给默认空串，缺省即「未提供」。 */
const parametersSchema = z.object({
  action: z.string(),
  task_id: z.string().default(''),
  task_input: z.string().default(''),
  schedule_type: z.string().default(''),
  run_at: z.string().default(''),
  cron_expr: z.string().default(''),
})

/** 工具入参的类型投影；由 parametersSchema 推导，保证运行时与编译期同源。 */
type ScheduledTaskParameters = z.infer<typeof parametersSchema>

/** 对外暴露给模型的 JSON Schema：字段描述即模型理解用法的唯一来源。 */
const PARAMETERS: AgentJsonObject = Object.freeze({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'update', 'delete', 'list', 'get'],
      description:
        '要执行的操作：create 创建；update 局部更新；delete 软删除；list 列出当前会话任务；get 查看单个任务。',
    },
    task_id: {
      type: 'string',
      description: '任务 ID。update、delete、get 时必填。',
    },
    task_input: {
      type: 'string',
      description:
        '任务触发时交给 Agent 的完整、自包含指令，不超过 4000 字；create 必填，update 可选。',
    },
    schedule_type: {
      type: 'string',
      enum: ['once', 'recurring'],
      description: '调度类型。create 必填，update 时仅在切换类型时提供。',
    },
    run_at: {
      type: 'string',
      description: '一次性任务触发时间；接受 RFC3339，或按配置时区解释的 YYYY-MM-DD HH:mm:ss。',
    },
    cron_expr: {
      type: 'string',
      description: '周期任务的 5 字段 cron 表达式（分 时 日 月 周，不含秒和年）。',
    },
  },
  required: ['action'],
})

/**
 * sys_scheduled_task_manage 工具：Agent 通过该工具创建、查询、更新和删除定时任务。
 * 由 task.module.ts 组装并注册进 Tool Registry；时间语义（时区、cron 与 run_at）统一在本类校验，
 * 持久化委托注入的 Task 仓储边界。
 *
 * **所有分支都先取 `currentScope(context)`**：工具参数里的 `task_id` 完全由模型提供，
 * 是不可信输入，因此每次操作都必须以「当前用户 + 当前会话」为作用域去查，
 * 而不是拿 task_id 直接读写。否则模型只要报出一个别人的 ID 就能越权操作。
 */
export class ScheduledTaskManageTool implements AgentTool {
  /** 工具在 Registry 中的注册名；与 Schema 的 function.name 必须一致。 */
  public readonly name = SCHEDULED_TASK_MANAGE_TOOL_NAME
  /** 对外暴露的 JSON Schema；参数清单即模型可填的字段全集。 */
  public readonly schema: AgentToolSchema = {
    type: 'function',
    function: {
      name: this.name,
      description:
        '管理当前会话的定时任务：创建、局部更新、删除、列表与详情查询。所有操作均校验当前用户和会话归属；本工具只管理任务，不会立即执行任务内容。',
      parameters: PARAMETERS,
    },
  }

  /** 任务读写边界；工具不直接触碰数据库。 */
  readonly #repositories: ScheduledTaskManagementRepositories
  /** ID 生成器；为新任务生成 STASK 前缀的业务 ID。 */
  readonly #idGenerator: IdGenerator
  /** 解释 run_at 与 cron 所用时区；构造时已校验合法。 */
  readonly #timezone: string
  /**
   * 时钟注入点；用于「run_at 是否为过去」判定与算下次触发，测试可注入固定时刻。
   * @returns 当前时刻
   */
  readonly #now: () => Date

  public constructor(
    repositories: ScheduledTaskManagementRepositories,
    idGenerator: IdGenerator,
    timezone: string,
    now: () => Date = (): Date => new Date()
  ) {
    validateTimezone(timezone)
    this.#repositories = repositories
    this.#idGenerator = idGenerator
    this.#timezone = timezone
    this.#now = now
  }

  /**
   * 执行工具调用：先校验参数与作用域，再按 action 分派到对应私有方法。
   * 所有分支都以「当前用户 + 当前会话」为作用域，不信任参数里的 `task_id`。
   *
   * @param value - 模型给出的原始参数，形状不可信，先过 Schema。
   * @param context - 调用上下文，提供当前会话与用户归属。
   * @param signal - 取消信号；进入时先检查，随后透传到仓储。
   * @returns 工具结果；内容为 JSON 字符串，未知 action 时抛错。
   */
  public async execute(
    value: AgentJsonValue,
    context: AgentToolCallContext,
    signal: AbortSignal
  ): Promise<AgentToolResult> {
    signal.throwIfAborted()
    const parsed = parametersSchema.safeParse(value)
    if (!parsed.success) throw new Error('参数解析失败', { cause: parsed.error })
    const scope = currentScope(context)
    let content: string
    switch (parsed.data.action) {
      case 'create':
        content = await this.#create(scope, parsed.data, signal)
        break
      case 'update':
        content = await this.#update(scope, parsed.data, signal)
        break
      case 'delete':
        content = await this.#delete(scope, parsed.data.task_id, signal)
        break
      case 'list':
        content = await this.#list(scope, signal)
        break
      case 'get':
        content = await this.#get(scope, parsed.data.task_id, signal)
        break
      default:
        throw new Error(
          `未知 action ${JSON.stringify(parsed.data.action)}：仅支持 create/update/delete/list/get`
        )
    }
    return { content }
  }

  /**
   * create 分支：校验输入并组装新任务后落库；归属取自 scope 而非参数。
   *
   * @param scope - 当前用户与会话组成的作用域。
   * @param parameters - 已校验的入参；create 要求非空的 task_input。
   * @param signal - 取消信号，透传到仓储。
   * @returns 面向模型的 JSON 结果字符串。
   */
  async #create(
    scope: TaskScope,
    parameters: ScheduledTaskParameters,
    signal: AbortSignal
  ): Promise<string> {
    validateTaskInput(parameters.task_input, true)
    const task = this.#buildTask(scope, parameters)
    try {
      await this.#repositories.commands.createTask(task, signal)
    } catch (cause: unknown) {
      throw contextualError('创建任务失败', cause)
    }
    return taskResult(task, '任务已创建')
  }

  /**
   * 组装新任务：基础字段 + 按调度类型填入触发时间（once → run_at；recurring → cron）。
   *
   * @param scope - 当前用户与会话组成的作用域，写入任务归属。
   * @param parameters - 已校验的入参；调度类型决定用 run_at 还是 cron_expr。
   * @returns 待落库的任务定义。
   */
  #buildTask(scope: TaskScope, parameters: ScheduledTaskParameters): AgentTaskDefinition {
    validateScheduleType(parameters.schedule_type)
    const task: AgentTaskDefinition = {
      taskId: this.#idGenerator.generate('STASK'),
      userId: scope.userId,
      sessionId: scope.sessionId,
      taskInput: parameters.task_input,
      cronExpr: '',
      scheduleType: parameters.schedule_type,
      isActive: true,
      retryCount: 0,
    }
    if (parameters.schedule_type === 'once') {
      if (parameters.run_at === '') {
        throw new Error('schedule_type=once 需要提供 run_at（触发时刻）')
      }
      if (parameters.cron_expr !== '') throw new Error('schedule_type=once 不接受 cron_expr')
      const runAt = parseRunAt(parameters.run_at, this.#timezone)
      if (runAt < this.#now()) {
        throw new Error('run_at 是过去时间，不会被调度；如需立即执行请填当前时间或之后')
      }
      task.runAt = runAt
      task.nextRunAt = runAt
    } else {
      if (parameters.cron_expr === '') {
        throw new Error('schedule_type=recurring 需要提供 cron_expr（5 字段 cron 表达式）')
      }
      if (parameters.run_at !== '') throw new Error('schedule_type=recurring 不接受 run_at')
      task.cronExpr = parameters.cron_expr
      task.nextRunAt = nextRecurring(parameters.cron_expr, this.#timezone, this.#now())
    }
    return task
  }

  /**
   * update 分支：按作用域加载归属任务后做局部更新；切换调度类型时要求同时提供对应时间字段，
   * 并在草稿上重算 nextRunAt，保证落库结果自洽。
   *
   * @param scope - 当前用户与会话组成的作用域。
   * @param parameters - 已校验的入参；至少提供一个可更新字段。
   * @param signal - 取消信号，透传到仓储。
   * @returns 面向模型的 JSON 结果字符串。
   */
  async #update(
    scope: TaskScope,
    parameters: ScheduledTaskParameters,
    signal: AbortSignal
  ): Promise<string> {
    if (parameters.task_id === '') throw new Error('update 需要提供 task_id')
    if (
      parameters.task_input === '' &&
      parameters.schedule_type === '' &&
      parameters.run_at === '' &&
      parameters.cron_expr === ''
    ) {
      throw new Error(
        '没有要更新的字段：请至少提供一个（task_input/schedule_type/run_at/cron_expr）'
      )
    }
    validateTaskInput(parameters.task_input, false)
    if (parameters.schedule_type !== '') validateScheduleType(parameters.schedule_type)
    const original = await this.#loadOwnedTask(scope, parameters.task_id, signal)
    const task: AgentTaskDefinition = structuredClone(original)
    let scheduleChanged = false
    if (parameters.task_input !== '') task.taskInput = parameters.task_input
    if (parameters.schedule_type !== '') {
      task.scheduleType = parameters.schedule_type
      scheduleChanged = true
    }
    if (parameters.run_at !== '') {
      if (task.scheduleType !== 'once') {
        throw new Error(`任务当前是 ${task.scheduleType}，传 run_at 需同时传 schedule_type=once`)
      }
      const runAt = parseRunAt(parameters.run_at, this.#timezone)
      if (runAt < this.#now()) throw new Error('run_at 是过去时间，不会被调度')
      task.runAt = runAt
      scheduleChanged = true
    }
    if (parameters.cron_expr !== '') {
      if (task.scheduleType !== 'recurring') {
        throw new Error(
          `任务当前是 ${task.scheduleType}，传 cron_expr 需同时传 schedule_type=recurring`
        )
      }
      nextRecurring(parameters.cron_expr, this.#timezone, this.#now())
      task.cronExpr = parameters.cron_expr
      scheduleChanged = true
    }
    if (task.scheduleType === 'once') {
      if (scheduleChanged && task.runAt === undefined)
        throw new Error('切换到 once 需要提供 run_at')
      task.cronExpr = ''
    } else {
      if (scheduleChanged && task.cronExpr === '') {
        throw new Error('切换到 recurring 需要提供 cron_expr')
      }
      task.runAt = undefined
    }
    if (scheduleChanged) {
      task.nextRunAt =
        task.scheduleType === 'once'
          ? task.runAt
          : nextRecurring(task.cronExpr, this.#timezone, this.#now())
    }
    try {
      await this.#repositories.commands.updateTaskContent(task, signal)
    } catch (cause: unknown) {
      throw contextualError('更新任务失败', cause)
    }
    return taskResult(task, '任务已更新')
  }

  /**
   * delete 分支：按作用域确认归属后再软删除，越权或不存在都报同一句「任务不存在或无权操作」。
   *
   * @param scope - 当前用户与会话组成的作用域。
   * @param taskId - 目标任务标识；空串即报错。
   * @param signal - 取消信号，透传到仓储。
   * @returns 面向模型的 JSON 结果字符串。
   */
  async #delete(scope: TaskScope, taskId: string, signal: AbortSignal): Promise<string> {
    if (taskId === '') throw new Error('delete 需要提供 task_id')
    await this.#loadOwnedTask(scope, taskId, signal)
    try {
      await this.#repositories.commands.softDeleteTask(scope.userId, taskId, signal)
    } catch (cause: unknown) {
      throw contextualError('删除任务失败', cause)
    }
    return JSON.stringify({ task_id: taskId, message: '任务已删除' })
  }

  /**
   * list 分支：列出作用域内仍活跃的任务并截断到上限，task_input 以预览形式返回。
   *
   * @param scope - 当前用户与会话组成的作用域。
   * @param signal - 取消信号，透传到仓储。
   * @returns 含数量与任务摘要数组的 JSON 字符串。
   */
  async #list(scope: TaskScope, signal: AbortSignal): Promise<string> {
    let tasks: readonly AgentTaskDefinition[]
    try {
      tasks = await this.#repositories.queries.listBySession(scope.sessionId, scope.userId, signal)
    } catch (cause: unknown) {
      throw contextualError('查询任务列表失败', cause)
    }
    const items = tasks
      .filter((task): boolean => task.isActive)
      .slice(0, MAX_LIST_ITEMS)
      .map((task): AgentJsonObject => taskSummary(task, true))
    return JSON.stringify({ count: items.length, tasks: items })
  }

  /**
   * get 分支：按作用域加载归属任务并返回完整摘要（不截断 task_input）。
   *
   * @param scope - 当前用户与会话组成的作用域。
   * @param taskId - 目标任务标识；空串即报错。
   * @param signal - 取消信号，透传到仓储。
   * @returns 单任务摘要的 JSON 字符串。
   */
  async #get(scope: TaskScope, taskId: string, signal: AbortSignal): Promise<string> {
    if (taskId === '') throw new Error('get 需要提供 task_id')
    return JSON.stringify(taskSummary(await this.#loadOwnedTask(scope, taskId, signal), false))
  }

  /**
   * 按作用域加载任务并把「不存在 / 非本人 / 非本人会话 / 已删除」统一收敛成同一句错误，
   * 让模型无法靠错误差异探测他人任务是否存在。
   *
   * @param scope - 当前用户与会话组成的作用域。
   * @param taskId - 目标任务标识。
   * @param signal - 取消信号，透传到仓储。
   * @returns 归属校验通过且仍活跃的任务定义。
   */
  async #loadOwnedTask(
    scope: TaskScope,
    taskId: string,
    signal: AbortSignal
  ): Promise<AgentTaskDefinition> {
    let task: AgentTaskDefinition
    try {
      task = await this.#repositories.queries.getTask(taskId, signal)
    } catch {
      throw new Error('任务不存在或无权操作')
    }
    if (task.sessionId !== scope.sessionId || task.userId !== scope.userId) {
      throw new Error('任务不存在或无权操作')
    }
    if (!task.isActive) throw new Error('任务不存在或已删除')
    return task
  }
}

/** 工具操作的作用域：由调用上下文派生，工具参数里的 task_id 一律据它校验归属。 */
interface TaskScope {
  /** 当前会话标识。 */
  readonly sessionId: string
  /** 当前登录用户标识。 */
  readonly userId: string
}

/**
 * 从调用上下文派生作用域；缺少会话或用户归属即拒绝，避免无归属的越权操作。
 *
 * @param context - Agent 工具调用上下文。
 * @returns 当前用户与会话组成的作用域。
 */
function currentScope(context: AgentToolCallContext): TaskScope {
  if (context.threadId === '' || context.userId === '') {
    throw new Error('当前上下文缺少会话或用户归属，拒绝操作')
  }
  return { sessionId: context.threadId, userId: context.userId }
}

/**
 * 校验 task_input：create 要求非空，任何分支都限制在字符数上限内。
 *
 * @param value - 待校验的 task_input。
 * @param required - 是否必填；update 允许留空表示不改动。
 */
function validateTaskInput(value: string, required: boolean): void {
  if (required && value.trim() === '') throw new Error('task_input 必填：请说明任务到点要执行什么')
  if (Array.from(value).length > MAX_TASK_INPUT_LENGTH) {
    throw new Error(`task_input 超过 ${String(MAX_TASK_INPUT_LENGTH)} 字上限`)
  }
}

/**
 * 校验调度类型取值；用断言签名让调用点之后的窄化直接生效。
 *
 * @param value - 待校验的调度类型。
 * @returns 无实际返回值；它是断言签名，通过校验后 value 在调用点被窄化为具体联合类型。
 */
function validateScheduleType(value: string): asserts value is 'once' | 'recurring' {
  if (value !== 'once' && value !== 'recurring') {
    throw new Error('schedule_type 非法：仅支持 once（一次性）或 recurring（周期）')
  }
}

/**
 * 把任务组装成 create/update 的标准化结果：返回 task_id、调度类型、下次触发与提示文案。
 *
 * @param task - 落库后的任务定义。
 * @param message - 面向用户的提示文案。
 * @returns JSON 字符串形式的结果。
 */
function taskResult(task: AgentTaskDefinition, message: string): string {
  return JSON.stringify({
    task_id: task.taskId,
    schedule_type: task.scheduleType,
    next_run_at: formatTaskTime(task.nextRunAt),
    message,
  })
}

/**
 * 把任务投影成给模型看的摘要对象：按调度类型只给对应的触发字段（once 给 run_at，recurring 给 cron_expr）。
 *
 * @param task - 待投影的任务定义。
 * @param preview - 是否截断 task_input；列表场景为 true，详情场景为 false。
 * @returns 摘要对象，供 JSON 序列化后返回给模型。
 */
function taskSummary(task: AgentTaskDefinition, preview: boolean): AgentJsonObject {
  const summary: Record<string, AgentJsonValue> = {
    task_id: task.taskId,
    schedule_type: task.scheduleType,
    is_active: task.isActive,
    next_run_at: formatTaskTime(task.nextRunAt),
    task_input: preview ? previewTaskInput(task.taskInput) : task.taskInput,
  }
  if (task.scheduleType === 'once') summary['run_at'] = formatTaskTime(task.runAt)
  else summary['cron_expr'] = task.cronExpr
  return summary
}

/**
 * 生成 task_input 的列表预览：按码点截断，避免撑大列表返回。
 *
 * @param value - 完整的 task_input。
 * @returns 截断并带省略号的预览文本。
 */
function previewTaskInput(value: string): string {
  return truncateCodePoints(value, PREVIEW_LENGTH, '…')
}

/**
 * 把可缺省的时刻格式化为 ISO 字符串；缺省时返回空串，让模型直观看到「无下次触发」。
 *
 * @param value - 待格式化的时刻；undefined 表示缺省。
 * @returns ISO 8601 字符串；输入缺省时为空串。
 */
function formatTaskTime(value: Date | undefined): string {
  return value?.toISOString() ?? ''
}
