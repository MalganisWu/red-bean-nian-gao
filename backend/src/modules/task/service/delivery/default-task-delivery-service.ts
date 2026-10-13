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

/** 会话待办队列的键前缀；与 processing 列表分属两个键，靠前缀区分命名空间。 */
const DELIVERY_QUEUE_PREFIX = 'delivery_queue:'
/** 会话「处理中」列表的键前缀；条目被 claim 后从待办移到这里，投递成功再摘除。 */
const DELIVERY_PROCESSING_PREFIX = 'delivery_processing:'

/**
 * 按会话串行投递定时任务结果。delivery 标记是 at-least-once 确认：
 * 修复标记前，已提交到会话的结果会先按 execution ID 去重。
 *
 * **按会话串行**由会话锁保证（`drain` 一进来就抢锁）：同一次投递不会有两个实例同时做，
 * 抢不到锁的那个直接返回、让持锁者去投——这是正常竞争而不是失败。
 * at-least-once 收敛到「实际只投一次」靠两处配合：投递与 `markExecutionDelivered` 是两个独立动作，
 * 中间崩溃会导致重复；而 `#deliverOne` 开头会先查 `execution.delivered`，把重复的那次跳过。
 * 实现 agent 的 `TaskResultDeliveryPort` 跨模块边界；Task 内部不再有独立的投递 Port，
 * 调度链通过本类直接调用。
 */
export class DeliveryQueue implements TaskResultDeliveryPort {
  /** 队列存储：待办/处理中两列表的原子搬运原语。 */
  readonly #store: DeliveryQueueStore
  /** 任务读取入口；投递前据此取任务与执行记录，收窄到真正用到的两个方法。 */
  readonly #taskQueries: Pick<TaskQueryRepository, 'getTask' | 'getExecutionById'>
  /** 投递确认与补偿扫描入口；收窄到标记已投递与列出未投递两个方法。 */
  readonly #executions: Pick<
    TaskExecutionRepository,
    'markExecutionDelivered' | 'listUndeliveredExecutions'
  >
  /** 会话写入 Port；把投递内容真正写进普通会话。 */
  readonly #writer: ExternalSessionTurnWriterPort
  /** 会话锁注册表；保证同一会话的投递同一时刻只有一个执行者。 */
  readonly #locks: DeliveryLockRegistry
  /** 时钟注入点；合成占位消息的时间戳取它，便于测试定时语义。 */
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

  /**
   * 把一次执行结果登记进会话的投递队列；条目以 `taskId:executionId` 去重。
   *
   * @param sessionId - 目标会话；空串表示无会话归属，静默跳过。
   * @param taskId - 任务标识，与执行 ID 一起构成去重键。
   * @param executionId - 执行记录标识，构成队列条目的另一半。
   * @param signal - 取消信号，透传到队列存储。
   */
  public async enqueue(
    sessionId: string,
    taskId: string,
    executionId: string,
    signal: AbortSignal
  ): Promise<void> {
    if (sessionId === '') return
    await this.#store.rightPush(queueKey(sessionId), entryKey(taskId, executionId), signal)
  }

  /**
   * 入队后立即对账并排空，是调度链投递结果的入口。
   *
   * @param sessionId - 目标会话。
   * @param taskId - 任务标识，与执行 ID 一起构成去重键。
   * @param executionId - 执行记录标识。
   * @param signal - 取消信号，透传到入队、对账与排空三步。
   */
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

  /**
   * 对账单会话：把库中尚未标记投递的执行补回队列，修复「落库成功但入队丢失」。
   *
   * @param sessionId - 目标会话；空串表示无会话归属，静默跳过。
   * @param signal - 取消信号，透传到库查询与补入队。
   */
  public async reconcile(sessionId: string, signal: AbortSignal): Promise<void> {
    if (sessionId === '') return
    const executions = await this.#executions.listUndeliveredExecutions(sessionId, signal)
    await this.#enqueueMissing(sessionId, executions, signal)
  }

  /**
   * 全量对账：扫出所有未投递执行，按会话分组补入队列后逐个排空。
   * 无会话归属的执行记录无处投递，直接跳过。
   *
   * @param signal - 取消信号，透传到每个会话的对账与排空。
   */
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

  /**
   * 排空一个会话的投递队列。
   *
   * 开头先 `recover`：把上次崩溃留在 processing 列表里的条目搬回待办队列——
   * 那些是「取出来但没投递完」的，不搬回来就永远没人处理。
   *
   * `claim` 把条目从待办移到 processing 后才开始投递，投递结束再 `remove`。
   * 这条流程保证了任何时刻条目都在某一侧，不会两头都不在。
   * 失败时 `requeue` 放回，然后分两种：**会话有待处理交互**就安静退出（等下次 drain 再来），
   * 其余错误上抛（让调用方看到）。两种都是先放回再决定，顺序不能反。
   *
   * @param sessionId - 目标会话；空串表示无会话归属，静默跳过。
   * @param signal - 取消信号，透传到队列存储与投递写入，抢到锁后贯穿整轮排空。
   */
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

  /**
   * 抢会话的投递锁。`LOCK_CONFLICT` 返回 `undefined` 而非抛错——
   * 「别人正在投递」是这套队列的正常竞争结果，不是故障；调用方据此静默退出即可。
   * 只有真正的锁后端错误才上抛。
   *
   * @param sessionId - 目标会话，作为锁的竞争键。
   * @param signal - 取消信号，透传到锁注册表。
   * @returns 取得的租约；锁冲突时返回 `undefined` 表示本轮让位。
   */
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

  /**
   * 把未投递的执行补进会话队列：先合并待办与处理中两侧的现有条目做去重，
   * 已在任一侧的条目不再重复入队，避免对账把同一执行投两次。
   *
   * @param sessionId - 目标会话；其待办与 processing 两列表都会被读取以去重。
   * @param executions - 待补入的未投递执行记录；为空时直接返回。
   * @param signal - 取消信号，透传到队列存储。
   */
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

  /**
   * 投递单条。开头两个短路都在处理「重复投递」：
   * 记录不存在（已被清理）与已标记投递（上一次成功但 remove 前崩溃）——两者都直接返回，
   * 这正是 at-least-once 收敛到「实际只投一次」的地方。
   * `deferred`（会话有未完成的交互）抛出专用的 `DeliveryDeferredError`，由上层放回队列。
   *
   * @param sessionId - 目标会话，投递结果写入其中。
   * @param taskId - 任务标识，用于回查任务定义。
   * @param executionId - 执行记录标识，兼作会话写入的外部幂等键。
   * @param fencingToken - 租约 token；透传给会话写入，供下游判断租约是否仍有效。
   * @param signal - 取消信号，透传到库查询与写入。
   */
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

  /**
   * 组装写入会话的投递内容：执行结果正文加"定时任务"前缀，缺失字段用空串兜底。
   *
   * @param sessionId - 目标会话标识。
   * @param task - 任务定义，提供归属用户与任务输入。
   * @param execution - 待投递的执行记录，提供结果正文与展示消息。
   * @param executionId - 执行记录标识，作为会话写入的外部幂等键。
   * @param fencingToken - 租约 token，透传给会话写入。
   * @returns 可直接交给会话写入 Port 的一轮外部会话内容。
   */
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

/**
 * 投递被推迟的内部信号：会话尚有未处理的交互，本轮不能写入。
 * 只在本文件内部流转，`drain` 捕获后把条目放回队列并安静退出，不当作故障上抛。
 */
class DeliveryDeferredError extends Error {
  public constructor() {
    super('投递延迟：会话有待处理的交互')
    this.name = 'DeliveryDeferredError'
  }
}

/**
 * 会话待办队列的键名。
 *
 * @param sessionId - 目标会话标识。
 * @returns 该会话待办队列的完整键。
 */
function queueKey(sessionId: string): string {
  return `${DELIVERY_QUEUE_PREFIX}${sessionId}`
}

/**
 * 会话处理中列表的键名。
 *
 * @param sessionId - 目标会话标识。
 * @returns 该会话处理中列表的完整键。
 */
function processingKey(sessionId: string): string {
  return `${DELIVERY_PROCESSING_PREFIX}${sessionId}`
}

/**
 * 队列条目的去重键：任务与执行 ID 一起唯一确定一次待投递，避免同一执行重复入队。
 *
 * @param taskId - 任务标识。
 * @param executionId - 执行记录标识。
 * @returns `taskId:executionId` 形式的条目串。
 */
function entryKey(taskId: string, executionId: string): string {
  return `${taskId}:${executionId}`
}

/**
 * 把条目串拆回任务与执行 ID；缺分隔符时整体当作任务 ID、执行 ID 置空，
 * 让损坏条目在后续查询里自然落到「找不到」而不是抛错。
 *
 * @param value - 队列里的条目串。
 * @returns 拆出的任务 ID 与执行 ID。
 */
function splitEntry(value: string): { readonly taskId: string; readonly executionId: string } {
  const separator = value.indexOf(':')
  return separator < 0
    ? { taskId: value, executionId: '' }
    : { taskId: value.slice(0, separator), executionId: value.slice(separator + 1) }
}

/**
 * 把未知异常归一为可读消息：Error 取其 message，其余直接字符串化，用于拼装投递失败日志。
 *
 * @param value - 被捕获的未知值，可能是 Error 也可能是任意抛出物。
 * @returns 用于日志的错误描述文本。
 */
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
