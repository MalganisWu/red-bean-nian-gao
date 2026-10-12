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

const MAX_LIST_ITEMS = 20
const PREVIEW_LENGTH = 80

const parametersSchema = z.object({
  action: z.string(),
  task_id: z.string().default(''),
  task_input: z.string().default(''),
  schedule_type: z.string().default(''),
  run_at: z.string().default(''),
  cron_expr: z.string().default(''),
})

type ScheduledTaskParameters = z.infer<typeof parametersSchema>

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
  public readonly name = SCHEDULED_TASK_MANAGE_TOOL_NAME
  public readonly schema: AgentToolSchema = {
    type: 'function',
    function: {
      name: this.name,
      description:
        '管理当前会话的定时任务：创建、局部更新、删除、列表与详情查询。所有操作均校验当前用户和会话归属；本工具只管理任务，不会立即执行任务内容。',
      parameters: PARAMETERS,
    },
  }

  readonly #repositories: ScheduledTaskManagementRepositories
  readonly #idGenerator: IdGenerator
  readonly #timezone: string
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

  /** 组装新任务：基础字段 + 按调度类型填入触发时间（once → run_at；recurring → cron）。 */
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

  async #get(scope: TaskScope, taskId: string, signal: AbortSignal): Promise<string> {
    if (taskId === '') throw new Error('get 需要提供 task_id')
    return JSON.stringify(taskSummary(await this.#loadOwnedTask(scope, taskId, signal), false))
  }

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

interface TaskScope {
  readonly sessionId: string
  readonly userId: string
}

function currentScope(context: AgentToolCallContext): TaskScope {
  if (context.threadId === '' || context.userId === '') {
    throw new Error('当前上下文缺少会话或用户归属，拒绝操作')
  }
  return { sessionId: context.threadId, userId: context.userId }
}

function validateTaskInput(value: string, required: boolean): void {
  if (required && value.trim() === '') throw new Error('task_input 必填：请说明任务到点要执行什么')
  if (Array.from(value).length > MAX_TASK_INPUT_LENGTH) {
    throw new Error(`task_input 超过 ${String(MAX_TASK_INPUT_LENGTH)} 字上限`)
  }
}

function validateScheduleType(value: string): asserts value is 'once' | 'recurring' {
  if (value !== 'once' && value !== 'recurring') {
    throw new Error('schedule_type 非法：仅支持 once（一次性）或 recurring（周期）')
  }
}

function taskResult(task: AgentTaskDefinition, message: string): string {
  return JSON.stringify({
    task_id: task.taskId,
    schedule_type: task.scheduleType,
    next_run_at: formatTaskTime(task.nextRunAt),
    message,
  })
}

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

function previewTaskInput(value: string): string {
  return truncateCodePoints(value, PREVIEW_LENGTH, '…')
}

function formatTaskTime(value: Date | undefined): string {
  return value?.toISOString() ?? ''
}
