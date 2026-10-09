import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { IdGenerator } from './../../../../../src/shared/id/id-generator.js'
import type { JsonObject, ToolCallContext } from 'red-bean-qing-tuan/pipeline'

import type { AgentTaskDefinition } from './../../../../../src/modules/task/model/task.js'
import { SCHEDULED_TASK_MANAGE_TOOL_NAME } from './../../../../../src/modules/task/service/tool/task-tool-constants.js'
import { ScheduledTaskManageTool } from './../../../../../src/modules/task/service/tool/scheduled-task-tool.js'
import type {
  ScheduledTaskManagementCommandRepository,
  ScheduledTaskManagementQueryRepository,
} from './../../../../../src/modules/task/service/tool/port/scheduled-task-management-repository.port.js'

const NOW = new Date('2026-08-03T04:00:00.000Z')
const SIGNAL = new AbortController().signal
const CONTEXT: ToolCallContext = Object.freeze({
  threadId: 'sess-1',
  userId: 'user-1',
  requestId: 'request-1',
  traceId: 'trace-1',
  callId: 'call-1',
  checkpointRevision: 1n,
  fencingToken: 1n,
})

class StubIdGenerator implements IdGenerator {
  #count = 0

  public generate(prefix: string): string {
    this.#count += 1
    return `${prefix}_${String(this.#count).padStart(3, '0')}`
  }
}

class MemoryTaskManagementRepository
  implements ScheduledTaskManagementCommandRepository, ScheduledTaskManagementQueryRepository
{
  public readonly tasks = new Map<string, AgentTaskDefinition>()
  public error: Error | undefined

  public createTask(task: AgentTaskDefinition, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.error !== undefined) return Promise.reject(this.error)
    this.tasks.set(task.taskId, structuredClone(task))
    return Promise.resolve()
  }

  public getTask(taskId: string, signal: AbortSignal): Promise<AgentTaskDefinition> {
    signal.throwIfAborted()
    if (this.error !== undefined) return Promise.reject(this.error)
    const task = this.tasks.get(taskId)
    return task === undefined
      ? Promise.reject(new Error('task not found'))
      : Promise.resolve(structuredClone(task))
  }

  public updateTaskContent(task: AgentTaskDefinition, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.error !== undefined) return Promise.reject(this.error)
    this.tasks.set(task.taskId, structuredClone(task))
    return Promise.resolve()
  }

  public softDeleteTask(_userId: string, taskId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.error !== undefined) return Promise.reject(this.error)
    const task = this.tasks.get(taskId)
    if (task !== undefined) this.tasks.set(taskId, { ...task, isActive: false })
    return Promise.resolve()
  }

  public listBySession(
    sessionId: string,
    userId: string,
    signal: AbortSignal
  ): Promise<readonly AgentTaskDefinition[]> {
    signal.throwIfAborted()
    if (this.error !== undefined) return Promise.reject(this.error)
    return Promise.resolve(
      [...this.tasks.values()]
        .filter((task): boolean => task.sessionId === sessionId && task.userId === userId)
        .map((task): AgentTaskDefinition => structuredClone(task))
    )
  }
}

function createTool(
  repository: ScheduledTaskManagementCommandRepository & ScheduledTaskManagementQueryRepository
): ScheduledTaskManageTool {
  return new ScheduledTaskManageTool(
    { commands: repository, queries: repository },
    new StubIdGenerator(),
    'Asia/Shanghai',
    () => NOW
  )
}

async function run(
  tool: ScheduledTaskManageTool,
  parameters: JsonObject,
  context: ToolCallContext = CONTEXT
): Promise<unknown> {
  const result = await tool.execute(parameters, context, SIGNAL)
  return JSON.parse(result.content)
}

void describe('scheduled task management tool', () => {
  void it('creates a one-time task from local or RFC3339 time', async () => {
    const repository = new MemoryTaskManagementRepository()
    const tool = createTool(repository)

    assert.deepEqual(
      await run(tool, {
        action: 'create',
        task_input: '提醒我喝水',
        schedule_type: 'once',
        run_at: '2026-08-10 10:00:00',
      }),
      {
        task_id: 'STASK_001',
        schedule_type: 'once',
        next_run_at: '2026-08-10T02:00:00.000Z',
        message: '任务已创建',
      }
    )
    assert.equal(
      repository.tasks.get('STASK_001')?.runAt?.toISOString(),
      '2026-08-10T02:00:00.000Z'
    )

    await run(tool, {
      action: 'create',
      task_input: '带偏移时间',
      schedule_type: 'once',
      run_at: '2026-08-10T10:00:00+08:00',
    })
    assert.equal(
      repository.tasks.get('STASK_002')?.runAt?.toISOString(),
      '2026-08-10T02:00:00.000Z'
    )
  })

  void it('creates a recurring task with its next timezone-aware run', async () => {
    const repository = new MemoryTaskManagementRepository()
    await run(createTool(repository), {
      action: 'create',
      task_input: '每天生成日报',
      schedule_type: 'recurring',
      cron_expr: '0 9 * * *',
    })

    const stored = repository.tasks.get('STASK_001')
    assert.equal(stored?.cronExpr, '0 9 * * *')
    assert.equal(stored?.runAt, undefined)
    assert.equal(stored?.nextRunAt?.toISOString(), '2026-08-04T01:00:00.000Z')
  })

  void it('rejects invalid creation requests before persistence', async () => {
    const invalid: readonly JsonObject[] = [
      { action: 'create', schedule_type: 'once', run_at: '2026-08-10 10:00:00' },
      {
        action: 'create',
        task_input: '字'.repeat(4_001),
        schedule_type: 'once',
        run_at: '2026-08-10 10:00:00',
      },
      { action: 'create', task_input: 'x' },
      { action: 'create', task_input: 'x', schedule_type: 'daily' },
      { action: 'create', task_input: 'x', schedule_type: 'once' },
      {
        action: 'create',
        task_input: 'x',
        schedule_type: 'once',
        run_at: '2026-08-10 10:00:00',
        cron_expr: '0 9 * * *',
      },
      { action: 'create', task_input: 'x', schedule_type: 'recurring' },
      {
        action: 'create',
        task_input: 'x',
        schedule_type: 'recurring',
        cron_expr: '0 9 * * *',
        run_at: '2026-08-10 10:00:00',
      },
      { action: 'create', task_input: 'x', schedule_type: 'once', run_at: '2026-08-01 10:00:00' },
      { action: 'create', task_input: 'x', schedule_type: 'recurring', cron_expr: '0 0 9 * * *' },
      { action: 'create', task_input: 'x', schedule_type: 'once', run_at: '明天' },
      { action: 'frobnicate' },
    ]
    for (const parameters of invalid) {
      const repository = new MemoryTaskManagementRepository()
      await assert.rejects(createTool(repository).execute(parameters, CONTEXT, SIGNAL))
      assert.equal(repository.tasks.size, 0)
    }
  })

  void it('fails closed when session or user ownership is missing', async () => {
    const tool = createTool(new MemoryTaskManagementRepository())
    const contexts: readonly ToolCallContext[] = [
      { ...CONTEXT, threadId: '' },
      { ...CONTEXT, userId: '' },
    ]
    for (const context of contexts) {
      await assert.rejects(tool.execute({ action: 'list' }, context, SIGNAL), /拒绝操作/u)
    }
  })

  void it('updates task input without recalculating its schedule', async () => {
    const repository = new MemoryTaskManagementRepository()
    const tool = createTool(repository)
    await run(tool, {
      action: 'create',
      task_input: '原内容',
      schedule_type: 'recurring',
      cron_expr: '0 9 * * *',
    })
    const originalNext = repository.tasks.get('STASK_001')?.nextRunAt

    await run(tool, { action: 'update', task_id: 'STASK_001', task_input: '新内容' })

    assert.equal(repository.tasks.get('STASK_001')?.taskInput, '新内容')
    assert.equal(
      repository.tasks.get('STASK_001')?.nextRunAt?.toISOString(),
      originalNext?.toISOString()
    )
  })

  void it('switches one-time and recurring schedule fields atomically', async () => {
    const repository = new MemoryTaskManagementRepository()
    const tool = createTool(repository)
    await run(tool, {
      action: 'create',
      task_input: 'x',
      schedule_type: 'once',
      run_at: '2026-08-10 10:00:00',
    })
    await run(tool, {
      action: 'update',
      task_id: 'STASK_001',
      schedule_type: 'recurring',
      cron_expr: '0 9 * * *',
    })
    assert.equal(repository.tasks.get('STASK_001')?.runAt, undefined)
    assert.equal(repository.tasks.get('STASK_001')?.cronExpr, '0 9 * * *')

    await run(tool, {
      action: 'update',
      task_id: 'STASK_001',
      schedule_type: 'once',
      run_at: '2026-08-20 10:00:00',
    })
    assert.equal(repository.tasks.get('STASK_001')?.cronExpr, '')
    assert.equal(
      repository.tasks.get('STASK_001')?.nextRunAt?.toISOString(),
      '2026-08-20T02:00:00.000Z'
    )
  })

  void it('rejects incomplete updates and cross-session access', async () => {
    const repository = new MemoryTaskManagementRepository()
    const tool = createTool(repository)
    repository.tasks.set('STASK_1', {
      taskId: 'STASK_1',
      sessionId: 'other-session',
      userId: 'user-1',
      taskInput: 'x',
      scheduleType: 'once',
      cronExpr: '',
      isActive: true,
      retryCount: 0,
    })

    await assert.rejects(tool.execute({ action: 'update', task_input: 'y' }, CONTEXT, SIGNAL))
    await assert.rejects(tool.execute({ action: 'update', task_id: 'STASK_1' }, CONTEXT, SIGNAL))
    await assert.rejects(
      tool.execute({ action: 'update', task_id: 'STASK_1', task_input: 'y' }, CONTEXT, SIGNAL),
      /不存在或无权操作/u
    )
  })

  void it('soft-deletes once and rejects repeat or missing deletion', async () => {
    const repository = new MemoryTaskManagementRepository()
    const tool = createTool(repository)
    await run(tool, {
      action: 'create',
      task_input: 'x',
      schedule_type: 'once',
      run_at: '2026-08-10 10:00:00',
    })

    assert.deepEqual(await run(tool, { action: 'delete', task_id: 'STASK_001' }), {
      task_id: 'STASK_001',
      message: '任务已删除',
    })
    assert.equal(repository.tasks.get('STASK_001')?.isActive, false)
    await assert.rejects(tool.execute({ action: 'delete', task_id: 'STASK_001' }, CONTEXT, SIGNAL))
    await assert.rejects(tool.execute({ action: 'delete' }, CONTEXT, SIGNAL))
  })

  void it('lists only active owned tasks, caps previews, and gets full input', async () => {
    const repository = new MemoryTaskManagementRepository()
    const tool = createTool(repository)
    const longInput = '甲'.repeat(120)
    for (let index = 0; index < 25; index += 1) {
      const taskId = `STASK_${String(index).padStart(2, '0')}`
      repository.tasks.set(taskId, {
        taskId,
        sessionId: 'sess-1',
        userId: 'user-1',
        taskInput: longInput,
        scheduleType: 'recurring',
        cronExpr: '0 9 * * *',
        isActive: true,
        retryCount: 0,
      })
    }
    const firstTask = repository.tasks.get('STASK_00')
    if (firstTask === undefined) throw new Error('missing task fixture')
    repository.tasks.set('DELETED', {
      ...firstTask,
      taskId: 'DELETED',
      isActive: false,
    })

    const listed = await run(tool, { action: 'list' })
    assert.ok(isJsonObject(listed))
    assert.equal(listed['count'], 20)
    const items = listed['tasks']
    assert.ok(Array.isArray(items))
    const first = items[0]
    assert.ok(isJsonObject(first))
    const preview = first['task_input']
    assert.equal(typeof preview, 'string')
    if (typeof preview !== 'string') throw new Error('task_input preview must be a string')
    assert.equal(Array.from(preview).length, 81)

    const detail = await run(tool, { action: 'get', task_id: 'STASK_00' })
    assert.ok(isJsonObject(detail))
    assert.equal(detail['task_input'], longInput)
  })

  void it('publishes the stable system tool schema', () => {
    const tool = createTool(new MemoryTaskManagementRepository())

    assert.equal(tool.name, SCHEDULED_TASK_MANAGE_TOOL_NAME)
    assert.equal(tool.schema.type, 'function')
    assert.equal(tool.schema.function.name, SCHEDULED_TASK_MANAGE_TOOL_NAME)
    assert.ok(tool.schema.function.description.length >= 40)
    const properties = tool.schema.function.parameters['properties']
    assert.ok(isJsonObject(properties))
    const action = properties['action']
    assert.ok(isJsonObject(action))
    assert.deepEqual(action['enum'], ['create', 'update', 'delete', 'list', 'get'])
  })
})

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
