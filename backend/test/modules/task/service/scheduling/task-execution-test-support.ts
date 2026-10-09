import type {
  BackgroundAgentExecutionCommand,
  BackgroundAgentExecutionPort,
  BackgroundAgentExecutionResult,
} from './../../../../../src/modules/agent/public-api.js'
import type { IdGenerator } from './../../../../../src/shared/id/id-generator.js'
import { NoopTracer } from './../../../../../src/shared/observability/tracer.js'
import type { DeliveryQueue } from './../../../../../src/modules/task/service/delivery/default-task-delivery-service.js'
import {
  TaskExecutionService,
  type ScheduledTaskRunState,
} from './../../../../../src/modules/task/service/scheduling/task-execution-service.js'
import type {
  AgentTaskDefinition,
  AgentTaskExecution,
  TaskPage,
} from './../../../../../src/modules/task/model/task.js'
import type { TaskCommandRepository } from './../../../../../src/modules/task/service/persistence/command/port/task-command-repository.port.js'
import type { TaskExecutionRepository } from './../../../../../src/modules/task/service/persistence/execution/port/task-execution-repository.port.js'
import type { TaskQueryRepository } from './../../../../../src/modules/task/service/persistence/query/port/task-query-repository.port.js'

export type TaskRepository = TaskCommandRepository & TaskQueryRepository & TaskExecutionRepository

export const SIGNAL = new AbortController().signal

export const POLICY = {
  maxRetries: 3,
  retryIntervalMilliseconds: 5 * 60_000,
  timezone: 'Asia/Shanghai',
}

export class TestIdGenerator implements IdGenerator {
  #index = 0

  public generate(prefix: string): string {
    this.#index += 1
    return `${prefix}_${String(this.#index)}`
  }
}

export class RecordingBackgroundAgent implements BackgroundAgentExecutionPort {
  public readonly commands: BackgroundAgentExecutionCommand[] = []
  public readonly cleared: string[] = []
  public result: BackgroundAgentExecutionResult = {
    status: 'completed',
    output: '完成',
    displayMessages: [{ role: 'assistant', content: '完成', timestamp: 1 }],
  }
  public failure: Error | undefined

  public execute(
    command: BackgroundAgentExecutionCommand,
    signal: AbortSignal
  ): Promise<BackgroundAgentExecutionResult> {
    signal.throwIfAborted()
    this.commands.push(command)
    return this.failure === undefined ? Promise.resolve(this.result) : Promise.reject(this.failure)
  }

  public clearRecovery(recoveryKey: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.cleared.push(recoveryKey)
    return Promise.resolve()
  }
}

export class TestTaskRepository implements TaskRepository {
  public readonly tasks = new Map<string, AgentTaskDefinition>()
  public readonly executions = new Map<string, AgentTaskExecution>()
  public saveError: Error | undefined
  public updates = 0
  public claimError: Error | undefined
  public readonly claims: Array<{ taskId: string; fencingToken: bigint }> = []

  public claimExecution(taskId: string, fencingToken: bigint, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.claims.push({ taskId, fencingToken })
    return this.claimError === undefined ? Promise.resolve() : Promise.reject(this.claimError)
  }

  public createTask(task: AgentTaskDefinition, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.tasks.set(task.taskId, task)
    return Promise.resolve()
  }

  public getTask(taskId: string, signal: AbortSignal): Promise<AgentTaskDefinition> {
    signal.throwIfAborted()
    const found = this.tasks.get(taskId)
    return found === undefined
      ? Promise.reject(new Error('task not found'))
      : Promise.resolve(found)
  }

  public updateTaskContent(task: AgentTaskDefinition, signal: AbortSignal): Promise<void> {
    return this.updateTask(task, signal)
  }

  public updateTask(task: AgentTaskDefinition, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.updates += 1
    this.tasks.set(task.taskId, task)
    return Promise.resolve()
  }

  public saveExecutionWithTaskUpdate(
    task: AgentTaskDefinition,
    execution: AgentTaskExecution,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (this.saveError !== undefined) return Promise.reject(this.saveError)
    this.tasks.set(task.taskId, task)
    this.executions.set(execution.executionId, execution)
    return Promise.resolve()
  }

  public getPendingTasks(
    _now: Date,
    _limit: number,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]> {
    signal.throwIfAborted()
    return Promise.resolve([])
  }

  public listByUser(
    _userId: string,
    _cursor: string,
    _limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskDefinition>> {
    signal.throwIfAborted()
    return Promise.resolve({ items: [], nextCursor: '' })
  }

  public listBySession(
    _sessionId: string,
    _userId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]> {
    signal.throwIfAborted()
    return Promise.resolve([])
  }

  public softDeleteTask(_userId: string, taskId: string, signal: AbortSignal): Promise<void> {
    return this.getTask(taskId, signal).then((value): void => {
      value.isActive = false
    })
  }

  public listExecutions(
    _taskId: string,
    _cursor: string,
    _limit: number,
    signal: AbortSignal
  ): Promise<TaskPage<AgentTaskExecution>> {
    signal.throwIfAborted()
    return Promise.resolve({ items: [], nextCursor: '' })
  }

  public getExecutionById(
    _taskId: string,
    executionId: string,
    signal: AbortSignal
  ): Promise<AgentTaskExecution | undefined> {
    signal.throwIfAborted()
    return Promise.resolve(this.executions.get(executionId))
  }

  public markExecutionDelivered(executionId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const current = this.executions.get(executionId)
    if (current === undefined || current.delivered) return Promise.resolve(false)
    this.executions.set(executionId, { ...current, delivered: true })
    return Promise.resolve(true)
  }

  public listUndeliveredExecutions(
    _sessionId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskExecution[]> {
    signal.throwIfAborted()
    return Promise.resolve([...this.executions.values()].filter((item): boolean => !item.delivered))
  }
}

export class RecordingQueue implements Pick<DeliveryQueue, 'queueDeliverExecution'> {
  public readonly entries: Array<{ sessionId: string; taskId: string; executionId: string }> = []

  public queueDeliverExecution(
    sessionId: string,
    taskId: string,
    executionId: string,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    this.entries.push({ sessionId, taskId, executionId })
    return Promise.resolve()
  }
}

export function task(overrides: Partial<AgentTaskDefinition> = {}): AgentTaskDefinition {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    userId: 'user-1',
    taskInput: '生成日报',
    cronExpr: '',
    scheduleType: 'once',
    isActive: true,
    retryCount: 0,
    nextRunAt: new Date('2026-08-04T10:00:00.000Z'),
    ...overrides,
  }
}

export function state(taskValue: AgentTaskDefinition = task()): ScheduledTaskRunState {
  return {
    task: taskValue,
    executionId: 'TAEX_1',
    traceId: 'trace-1',
    startedAt: new Date('2026-08-04T10:00:01.000Z'),
    fencingToken: 1n,
  }
}

export function createExecutionService(
  repository: TestTaskRepository,
  background: RecordingBackgroundAgent,
  queue?: RecordingQueue
): TaskExecutionService {
  return new TaskExecutionService({
    queries: repository,
    commands: repository,
    idGenerator: new TestIdGenerator(),
    background,
    queue,
    policy: POLICY,
    tracer: new NoopTracer(),
    traceIdFactory: (): string => 'trace-test',
  })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
