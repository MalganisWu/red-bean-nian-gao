import { DeliveryQueue } from './../../../../../src/modules/task/service/delivery/default-task-delivery-service.js'
import type { DeliveryQueueStore } from './../../../../../src/modules/task/service/delivery/port/delivery-queue.port.js'
import type {
  AgentTaskDefinition,
  AgentTaskExecution,
} from './../../../../../src/modules/task/model/task.js'
import type { TaskExecutionRepository } from './../../../../../src/modules/task/service/persistence/execution/port/task-execution-repository.port.js'
import type { TaskQueryRepository } from './../../../../../src/modules/task/service/persistence/query/port/task-query-repository.port.js'
import type { DisplayMessage } from './../../../../../src/modules/agent/presentation/model/display-message.js'
import { MemorySessionStore } from './../../../../../src/modules/agent/session/repository/adapter/memory-session-repository.js'
import type { Session } from './../../../../../src/modules/agent/session/model/session.js'
import type { FencedSessionRepository } from './../../../../../src/modules/agent/session/repository/port/session-repository.port.js'
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
} from './../../../../../src/modules/agent/session/lock/port/session-lock.js'
import { DefaultExternalSessionTurnWriter } from './../../../../../src/modules/agent/external-turn/service/default-external-session-turn-writer.js'
import { RuntimeStateCodec } from './../../../../../src/modules/agent/execution/adapter/runtime-state-codec.js'

export class MemoryDeliveryQueueStore implements DeliveryQueueStore {
  readonly #lists = new Map<string, string[]>()

  public rightPush(key: string, value: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const list = this.#lists.get(key) ?? []
    list.push(value)
    this.#lists.set(key, list)
    return Promise.resolve()
  }

  public list(key: string, signal: AbortSignal): Promise<readonly string[]> {
    signal.throwIfAborted()
    return Promise.resolve([...(this.#lists.get(key) ?? [])])
  }

  public claim(
    sourceKey: string,
    processingKey: string,
    signal: AbortSignal
  ): Promise<string | undefined> {
    signal.throwIfAborted()
    const source = this.#lists.get(sourceKey) ?? []
    const item = source.shift()
    this.#lists.set(sourceKey, source)
    if (item === undefined) return Promise.resolve(undefined)
    const processing = this.#lists.get(processingKey) ?? []
    processing.push(item)
    this.#lists.set(processingKey, processing)
    return Promise.resolve(item)
  }

  public requeue(
    sourceKey: string,
    processingKey: string,
    entry: string,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const processing = this.#lists.get(processingKey) ?? []
    const index = processing.indexOf(entry)
    if (index >= 0) {
      processing.splice(index, 1)
      this.#lists.set(processingKey, processing)
      const source = this.#lists.get(sourceKey) ?? []
      source.unshift(entry)
      this.#lists.set(sourceKey, source)
    }
    return Promise.resolve()
  }

  public recover(sourceKey: string, processingKey: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const source = this.#lists.get(sourceKey) ?? []
    const processing = this.#lists.get(processingKey) ?? []
    while (processing.length > 0) {
      const last = processing.pop()
      if (last !== undefined) source.unshift(last)
    }
    this.#lists.set(sourceKey, source)
    this.#lists.set(processingKey, processing)
    return Promise.resolve()
  }

  public remove(processingKey: string, entry: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const processing = this.#lists.get(processingKey) ?? []
    const index = processing.indexOf(entry)
    if (index >= 0) processing.splice(index, 1)
    this.#lists.set(processingKey, processing)
    return Promise.resolve()
  }

  public seed(key: string, entry: string): void {
    const list = this.#lists.get(key) ?? []
    list.push(entry)
    this.#lists.set(key, list)
  }
}

export class MemoryTaskRepository implements Pick<
  TaskQueryRepository & TaskExecutionRepository,
  'getTask' | 'getExecutionById' | 'markExecutionDelivered' | 'listUndeliveredExecutions'
> {
  readonly tasks = new Map<string, AgentTaskDefinition>()
  readonly executions = new Map<string, AgentTaskExecution>()
  #saveError: Error | undefined

  public add(
    taskId: string,
    executionId: string,
    sessionId = 'session-1',
    taskInput = '提醒喝水'
  ): void {
    this.tasks.set(taskId, {
      taskId,
      userId: 'user-1',
      sessionId,
      taskInput,
      cronExpr: '',
      scheduleType: 'once',
      isActive: true,
      retryCount: 0,
    })
    this.executions.set(executionId, execution(taskId, executionId, sessionId))
  }

  public failMarking(error: Error): void {
    this.#saveError = error
  }

  public getTask(taskId: string, signal: AbortSignal): Promise<AgentTaskDefinition> {
    signal.throwIfAborted()
    const task = this.tasks.get(taskId)
    if (task === undefined) return Promise.reject(new Error('task missing'))
    return Promise.resolve(task)
  }

  public getExecutionById(
    _taskId: string,
    executionId: string,
    signal: AbortSignal
  ): Promise<AgentTaskExecution | undefined> {
    signal.throwIfAborted()
    return Promise.resolve(this.executions.get(executionId))
  }

  public listUndeliveredExecutions(
    sessionId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskExecution[]> {
    signal.throwIfAborted()
    return Promise.resolve(
      [...this.executions.values()].filter(
        (item): boolean => !item.delivered && (sessionId === '' || item.sessionId === sessionId)
      )
    )
  }

  public markExecutionDelivered(executionId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    if (this.#saveError !== undefined) return Promise.reject(this.#saveError)
    const execution = this.executions.get(executionId)
    if (execution === undefined || execution.delivered) return Promise.resolve(false)
    this.executions.set(executionId, { ...execution, delivered: true })
    return Promise.resolve(true)
  }
}

export class FailingSessionStore extends MemorySessionStore {
  public override save(_session: Session, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return Promise.reject(new Error('save failure'))
  }
}

export class TestLockRegistry {
  #held = false

  public tryAcquire(
    sessionId: string,
    owner: string
  ): Promise<{ readonly fencingToken: bigint; release(): Promise<void> }> {
    if (sessionId === '' || owner === '')
      return Promise.reject(new Error('lock identity is required'))
    if (this.#held) return Promise.reject(new RegistryError(REGISTRY_ERROR_CODES.LOCK_CONFLICT))
    this.#held = true
    return Promise.resolve({
      fencingToken: 7n,
      release: (): Promise<void> => {
        this.#held = false
        return Promise.resolve()
      },
    })
  }
}

export function createHarness(sessions: FencedSessionRepository = new MemorySessionStore()): {
  readonly queue: DeliveryQueue
  readonly store: MemoryDeliveryQueueStore
  readonly tasks: MemoryTaskRepository
  readonly sessions: FencedSessionRepository
  readonly locks: TestLockRegistry
} {
  const store = new MemoryDeliveryQueueStore()
  const tasks = new MemoryTaskRepository()
  const locks = new TestLockRegistry()
  const writer = new DefaultExternalSessionTurnWriter(sessions, locks, new RuntimeStateCodec())
  return {
    queue: new DeliveryQueue(store, tasks, tasks, writer, locks),
    store,
    tasks,
    sessions,
    locks,
  }
}

export function execution(
  taskId: string,
  executionId: string,
  sessionId: string
): AgentTaskExecution {
  return {
    executionId,
    taskId,
    sessionId,
    status: 'completed',
    scheduledAt: new Date('2026-08-04T10:00:00.000Z'),
    displayMessages: [{ role: 'assistant', content: `结果-${executionId}`, timestamp: 100 }],
    resultMessage: `结果-${executionId}`,
    delivered: false,
  }
}

export function display(executionId: string): DisplayMessage {
  return {
    role: 'assistant',
    content: `结果-${executionId}`,
    timestamp: 100,
    source: 'scheduled_task',
    meta: {
      scheduledTask: {
        taskId: 'task-1',
        taskName: '提醒喝水',
        status: 'completed',
        executionId,
        scheduledAt: 0,
        completedAt: 0,
      },
    },
  }
}

export function signal(): AbortSignal {
  return new AbortController().signal
}
