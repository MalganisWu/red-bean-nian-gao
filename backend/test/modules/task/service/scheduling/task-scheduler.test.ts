import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  REGISTRY_ERROR_CODES,
  RegistryError,
} from './../../../../../src/modules/agent/session/lock/port/session-lock.js'

import { ScheduledTaskScheduler } from './../../../../../src/modules/task/service/scheduling/default-task-scheduler.js'
import type {
  ScheduledTaskLease,
  ScheduledTaskLockRegistry,
  SchedulerConfig,
} from './../../../../../src/modules/task/service/scheduling/port/task-scheduler.port.js'
import type { AgentTaskDefinition } from './../../../../../src/modules/task/model/task.js'
import type { Logger } from './../../../../../src/infra/logger/logger.js'
import { ScheduledTaskWorker } from './../../../../../src/modules/task/service/scheduling/scheduled-task-worker.js'
import type { TaskSchedulerPort } from './../../../../../src/modules/task/service/scheduling/port/task-scheduler.port.js'

const config: SchedulerConfig = {
  batchSize: 100,
  maxConcurrent: 4,
  executionTimeoutMilliseconds: 60_000,
}

class StubTaskRepository {
  public tasks: readonly AgentTaskDefinition[] = []
  public requestedLimit = 0

  public getPendingTasks(
    _now: Date,
    limit: number,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]> {
    signal.throwIfAborted()
    this.requestedLimit = limit
    return Promise.resolve(this.tasks)
  }
}

class StubLease implements ScheduledTaskLease {
  public readonly fencingToken = 1n
  public readonly lost: Promise<Error>
  public releases = 0
  readonly #resolveLost: (error: Error) => void

  public constructor() {
    let resolveLost: ((error: Error) => void) | undefined
    this.lost = new Promise<Error>((resolve) => {
      resolveLost = resolve
    })
    if (resolveLost === undefined) throw new Error('failed to create lease')
    this.#resolveLost = resolveLost
  }

  public lose(error: Error): void {
    this.#resolveLost(error)
  }

  public release(): Promise<void> {
    this.releases += 1
    return Promise.resolve()
  }
}

class StubLockRegistry implements ScheduledTaskLockRegistry {
  public readonly lease = new StubLease()
  public error: Error | undefined

  public tryAcquire(
    _sessionId: string,
    _requestId: string,
    signal: AbortSignal
  ): Promise<ScheduledTaskLease> {
    signal.throwIfAborted()
    return this.error === undefined ? Promise.resolve(this.lease) : Promise.reject(this.error)
  }
}

class RecordingLogger implements Logger {
  public readonly errors: string[] = []

  public child(): Logger {
    return this
  }

  public debug(): void {}

  public info(): void {}

  public warn(): void {}

  public error(message: string): void {
    this.errors.push(message)
  }
}

class RecordingWorkerScheduler implements TaskSchedulerPort {
  public scans = 0
  public idleWaits = 0
  readonly #stop: AbortController

  public constructor(stop: AbortController) {
    this.#stop = stop
  }

  public scanOnce(): Promise<void> {
    this.scans += 1
    this.#stop.abort(new Error('测试完成'))
    return Promise.resolve()
  }

  public executeTask(): Promise<void> {
    return Promise.resolve()
  }

  public waitForIdle(): Promise<void> {
    this.idleWaits += 1
    return Promise.resolve()
  }
}

function scheduledTask(taskId: string): AgentTaskDefinition {
  return {
    taskId,
    userId: 'USER_1',
    sessionId: 'SESS_1',
    taskInput: taskId,
    cronExpr: '',
    scheduleType: 'once',
    isActive: true,
    retryCount: 0,
  }
}

void describe('scheduled task scheduler', () => {
  void it('recovers a rejected or synchronously throwing pipeline', async () => {
    const repository = new StubTaskRepository()
    const locks = new StubLockRegistry()
    const logger = new RecordingLogger()
    const scheduler = new ScheduledTaskScheduler(
      repository,
      (): Promise<void> => {
        throw new Error('pipeline boom')
      },
      locks,
      config,
      logger
    )

    await scheduler.executeTask(scheduledTask('task-panic-1'), AbortSignal.timeout(1_000))

    assert.equal(locks.lease.releases, 1)
    assert.deepEqual(logger.errors, ['scheduled task failed'])
  })

  void it('bounds each scan by batch size and concurrency', async () => {
    const repository = new StubTaskRepository()
    repository.tasks = [scheduledTask('task-1'), scheduledTask('task-2'), scheduledTask('task-3')]
    const locks = new StubLockRegistry()
    let active = 0
    let maxActive = 0
    let release: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const scheduler = new ScheduledTaskScheduler(
      repository,
      async (): Promise<void> => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await barrier
        active -= 1
      },
      locks,
      { ...config, batchSize: 2, maxConcurrent: 2 },
      new RecordingLogger()
    )

    await scheduler.scanOnce(AbortSignal.timeout(1_000))
    await waitUntil((): boolean => active === 2)
    assert.equal(repository.requestedLimit, 2)
    assert.equal(maxActive, 2)
    release?.()
    await scheduler.waitForIdle()
  })

  void it('enforces the configured execution timeout', async () => {
    const repository = new StubTaskRepository()
    const locks = new StubLockRegistry()
    let receivedReason: unknown
    const scheduler = new ScheduledTaskScheduler(
      repository,
      async (_taskId, _lease, signal): Promise<void> => {
        await waitForAbort(signal)
        receivedReason = signal.reason
      },
      locks,
      { ...config, executionTimeoutMilliseconds: 20 },
      new RecordingLogger()
    )

    await scheduler.executeTask(scheduledTask('timeout'), new AbortController().signal)

    assert.ok(receivedReason instanceof Error)
    assert.match(receivedReason.message, /执行超时/u)
  })

  void it('cancels the pipeline when its lease is lost', async () => {
    const repository = new StubTaskRepository()
    const locks = new StubLockRegistry()
    const leaseLost = new RegistryError(REGISTRY_ERROR_CODES.LEASE_LOST)
    let receivedReason: unknown
    let started: (() => void) | undefined
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const scheduler = new ScheduledTaskScheduler(
      repository,
      async (_taskId, _lease, signal): Promise<void> => {
        started?.()
        await waitForAbort(signal)
        receivedReason = signal.reason
      },
      locks,
      config,
      new RecordingLogger()
    )

    const execution = scheduler.executeTask(
      scheduledTask('lease-lost'),
      new AbortController().signal
    )
    await startedPromise
    locks.lease.lose(leaseLost)
    await execution

    assert.equal(receivedReason, leaseLost)
  })

  void it('lets the worker stop idempotently and skips lock conflicts without running', async () => {
    const repository = new StubTaskRepository()
    const locks = new StubLockRegistry()
    locks.error = new RegistryError(REGISTRY_ERROR_CODES.LOCK_CONFLICT)
    let calls = 0
    const scheduler = new ScheduledTaskScheduler(
      repository,
      (): Promise<void> => {
        calls += 1
        return Promise.resolve()
      },
      locks,
      config,
      new RecordingLogger()
    )
    const worker = new ScheduledTaskWorker(scheduler, new RecordingLogger(), 60_000)

    await scheduler.executeTask(scheduledTask('conflict'), new AbortController().signal)
    await Promise.all([worker.stop(), worker.stop()])

    assert.equal(calls, 0)
  })

  void it('starts scanning and waits for scheduler idle during shutdown', async () => {
    const stop = new AbortController()
    const scheduler = new RecordingWorkerScheduler(stop)
    const worker = new ScheduledTaskWorker(scheduler, new RecordingLogger(), 1)

    await worker.start(stop.signal)

    assert.equal(scheduler.scans, 1)
    assert.equal(scheduler.idleWaits, 1)
  })
})

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', (): void => resolve(), { once: true })
  })
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}
