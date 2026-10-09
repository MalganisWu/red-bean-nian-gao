import type {
  ExternalSessionTurn,
  ExternalSessionTurnWriterPort,
  TaskResultDeliveryPort,
} from './../../../agent/public-api.js'
import { REGISTRY_ERROR_CODES, RegistryError } from './../../../agent/public-api.js'
import type { AgentTaskDefinition, AgentTaskExecution } from './../../model/task.js'
import type { TaskExecutionRepository } from './../persistence/execution/port/task-execution-repository.port.js'
import type { TaskQueryRepository } from './../persistence/query/port/task-query-repository.port.js'
import type {
  DeliveryLease,
  DeliveryLockRegistry,
  DeliveryQueueStore,
} from './port/delivery-queue.port.js'
import { buildDeliveryDisplayMessages } from './task-delivery-message.js'

const DELIVERY_QUEUE_PREFIX = 'delivery_queue:'
const DELIVERY_PROCESSING_PREFIX = 'delivery_processing:'

/**
 * 按会话串行投递定时任务结果。delivery 标记是 at-least-once 确认：
 * 修复标记前，已提交到会话的结果会先按 execution ID 去重。
 * 实现 agent 的 `TaskResultDeliveryPort` 跨模块边界；Task 内部不再有独立的投递 Port，
 * 调度链通过本类直接调用。
 */
export class DeliveryQueue implements TaskResultDeliveryPort {
  readonly #store: DeliveryQueueStore
  readonly #taskQueries: Pick<TaskQueryRepository, 'getTask' | 'getExecutionById'>
  readonly #executions: Pick<
    TaskExecutionRepository,
    'markExecutionDelivered' | 'listUndeliveredExecutions'
  >
  readonly #writer: ExternalSessionTurnWriterPort
  readonly #locks: DeliveryLockRegistry
  readonly #now: () => Date

  public constructor(
    store: DeliveryQueueStore,
    taskQueries: Pick<TaskQueryRepository, 'getTask' | 'getExecutionById'>,
    executions: Pick<
      TaskExecutionRepository,
      'markExecutionDelivered' | 'listUndeliveredExecutions'
    >,
    writer: ExternalSessionTurnWriterPort,
    locks: DeliveryLockRegistry,
    now: () => Date = (): Date => new Date()
  ) {
    this.#store = store
    this.#taskQueries = taskQueries
    this.#executions = executions
    this.#writer = writer
    this.#locks = locks
    this.#now = now
  }

  public async enqueue(
    sessionId: string,
    taskId: string,
    executionId: string,
    signal: AbortSignal
  ): Promise<void> {
    if (sessionId === '') return
    await this.#store.rightPush(queueKey(sessionId), entryKey(taskId, executionId), signal)
  }

  public async queueDeliverExecution(
    sessionId: string,
    taskId: string,
    executionId: string,
    signal: AbortSignal
  ): Promise<void> {
    await this.enqueue(sessionId, taskId, executionId, signal)
    await this.reconcile(sessionId, signal)
    await this.drain(sessionId, signal)
  }

  public async reconcile(sessionId: string, signal: AbortSignal): Promise<void> {
    if (sessionId === '') return
    const executions = await this.#executions.listUndeliveredExecutions(sessionId, signal)
    await this.#enqueueMissing(sessionId, executions, signal)
  }

  public async reconcileAll(signal: AbortSignal): Promise<void> {
    const executions = await this.#executions.listUndeliveredExecutions('', signal)
    const bySession = new Map<string, AgentTaskExecution[]>()
    for (const execution of executions) {
      if (execution.sessionId === '') continue
      const grouped = bySession.get(execution.sessionId) ?? []
      grouped.push(execution)
      bySession.set(execution.sessionId, grouped)
    }
    for (const [sessionId, items] of bySession) {
      await this.#enqueueMissing(sessionId, items, signal)
    }
    for (const sessionId of bySession.keys()) {
      await this.drain(sessionId, signal)
    }
  }

  public async drain(sessionId: string, signal: AbortSignal): Promise<void> {
    if (sessionId === '') return
    const lease = await this.#tryAcquire(sessionId, signal)
    if (lease === undefined) return
    try {
      await this.#store.recover(queueKey(sessionId), processingKey(sessionId), signal)
      while (true) {
        const entry = await this.#store.claim(queueKey(sessionId), processingKey(sessionId), signal)
        if (entry === undefined) return
        const parsed = splitEntry(entry)
        try {
          await this.#deliverOne(
            sessionId,
            parsed.taskId,
            parsed.executionId,
            lease.fencingToken,
            signal
          )
        } catch (cause: unknown) {
          await this.#store.requeue(queueKey(sessionId), processingKey(sessionId), entry, signal)
          if (cause instanceof DeliveryDeferredError) return
          throw new Error(`投递执行记录失败: ${errorMessage(cause)}`, { cause })
        }
        await this.#store.remove(processingKey(sessionId), entry, signal)
      }
    } finally {
      await lease.release()
    }
  }

  async #tryAcquire(sessionId: string, signal: AbortSignal): Promise<DeliveryLease | undefined> {
    try {
      return await this.#locks.tryAcquire(sessionId, `delivery:${sessionId}`, signal)
    } catch (cause: unknown) {
      if (cause instanceof RegistryError && cause.code === REGISTRY_ERROR_CODES.LOCK_CONFLICT) {
        return undefined
      }
      throw cause
    }
  }

  async #enqueueMissing(
    sessionId: string,
    executions: readonly AgentTaskExecution[],
    signal: AbortSignal
  ): Promise<void> {
    if (executions.length === 0) return
    const queued = await this.#store.list(queueKey(sessionId), signal)
    const processing = await this.#store.list(processingKey(sessionId), signal)
    const known = new Set([...queued, ...processing])
    for (const execution of executions) {
      const entry = entryKey(execution.taskId, execution.executionId)
      if (known.has(entry)) continue
      await this.#store.rightPush(queueKey(sessionId), entry, signal)
      known.add(entry)
    }
  }

  async #deliverOne(
    sessionId: string,
    taskId: string,
    executionId: string,
    fencingToken: bigint | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const execution = await this.#taskQueries.getExecutionById(taskId, executionId, signal)
    if (execution === undefined || execution.delivered) return
    const task = await this.#taskQueries.getTask(taskId, signal)
    const result = await this.#writer.write(
      this.#buildDeliveryContent(sessionId, task, execution, executionId, fencingToken),
      signal
    )
    if (result === 'deferred') throw new DeliveryDeferredError()
    await this.#executions.markExecutionDelivered(executionId, signal)
  }

  /** 组装写入会话的投递内容：执行结果正文加"定时任务"前缀，缺失字段用空串兜底。 */
  #buildDeliveryContent(
    sessionId: string,
    task: AgentTaskDefinition,
    execution: AgentTaskExecution,
    executionId: string,
    fencingToken: bigint | undefined
  ): ExternalSessionTurn {
    return {
      sessionId,
      userId: task.userId,
      externalId: executionId,
      userContent: task.taskInput === '' ? '' : `（定时任务执行）${task.taskInput}`,
      assistantContent: execution.resultMessage ?? '',
      displayMessages: buildDeliveryDisplayMessages(execution, task, executionId, this.#now),
      fencingToken,
    }
  }
}

class DeliveryDeferredError extends Error {
  public constructor() {
    super('投递延迟：会话有待处理的交互')
    this.name = 'DeliveryDeferredError'
  }
}

function queueKey(sessionId: string): string {
  return `${DELIVERY_QUEUE_PREFIX}${sessionId}`
}

function processingKey(sessionId: string): string {
  return `${DELIVERY_PROCESSING_PREFIX}${sessionId}`
}

function entryKey(taskId: string, executionId: string): string {
  return `${taskId}:${executionId}`
}

function splitEntry(value: string): { readonly taskId: string; readonly executionId: string } {
  const separator = value.indexOf(':')
  return separator < 0
    ? { taskId: value, executionId: '' }
    : { taskId: value.slice(0, separator), executionId: value.slice(separator + 1) }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
