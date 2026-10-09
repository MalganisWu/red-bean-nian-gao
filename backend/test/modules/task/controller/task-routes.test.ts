import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createHttpServer } from './../../../../src/shared/http/fastify-http-boundary.js'
import { registerTaskRoutes } from './../../../../src/modules/task/http-api.js'
import { TaskCommandService } from './../../../../src/modules/task/service/cases/task-command-service.js'
import { TaskQueryService } from './../../../../src/modules/task/service/cases/task-query-service.js'
import type { DisplayMessage } from './../../../../src/modules/agent/presentation/model/display-message.js'
import {
  type AgentTaskDefinition,
  type AgentTaskExecution,
  type AgentTaskListItem,
  type ExecutionViewState,
  type TaskPage,
} from './../../../../src/modules/task/model/task.js'
import type { TaskCommandRepository } from './../../../../src/modules/task/service/persistence/command/port/task-command-repository.port.js'
import type { TaskExecutionRepository } from './../../../../src/modules/task/service/persistence/execution/port/task-execution-repository.port.js'
import type { TaskListRepository } from './../../../../src/modules/task/service/persistence/list/port/task-list-repository.port.js'
import type { TaskQueryRepository } from './../../../../src/modules/task/service/persistence/query/port/task-query-repository.port.js'
import type { ExecutionViewStateRepository } from './../../../../src/modules/task/service/persistence/view-state/port/execution-view-state-repository.port.js'
import type { AuthServicePort } from './../../../../src/modules/identity/service/authentication/port/auth-service.port.js'

class TestAuth implements AuthServicePort {
  public login(): Promise<string> {
    return Promise.resolve('token')
  }
  public logout(): Promise<void> {
    return Promise.resolve()
  }
  public validateToken(): Promise<string> {
    return Promise.resolve('USER_1')
  }
  public refreshToken(): Promise<string> {
    return Promise.resolve('token')
  }
}

class TaskRepositoryStub
  implements
    TaskCommandRepository,
    TaskQueryRepository,
    TaskExecutionRepository,
    TaskListRepository,
    ExecutionViewStateRepository
{
  public listUserId = ''
  public listCursor = ''
  public listLimit = 0
  public sessionId = ''
  public sessionUserId = ''
  public executionIds: readonly string[] = []
  public upsert:
    | {
        readonly userId: string
        readonly executionId: string
        readonly markSeen: boolean
        readonly collapsedOverride: boolean | undefined
      }
    | undefined
  public listItems: readonly AgentTaskListItem[] = []
  public sessionItems: readonly AgentTaskListItem[] = []
  public viewStates: readonly ExecutionViewState[] = []
  public task: AgentTaskDefinition = taskDefinition('USER_1')
  public execution: AgentTaskExecution | undefined = executionRecord()

  public claimExecution(): Promise<void> {
    return Promise.resolve()
  }

  public createTask(): Promise<void> {
    return Promise.resolve()
  }
  public getTask(): Promise<AgentTaskDefinition> {
    return Promise.resolve(structuredClone(this.task))
  }
  public updateTaskContent(): Promise<void> {
    return Promise.resolve()
  }
  public updateTask(): Promise<void> {
    return Promise.resolve()
  }
  public saveExecutionWithTaskUpdate(): Promise<void> {
    return Promise.resolve()
  }
  public incrementRetryCount(): Promise<number> {
    return Promise.resolve(1)
  }
  public getPendingTasks(): Promise<readonly AgentTaskDefinition[]> {
    return Promise.resolve([])
  }
  public saveExecution(): Promise<void> {
    return Promise.resolve()
  }
  public getExecution(): Promise<AgentTaskExecution | undefined> {
    return Promise.resolve(this.execution)
  }
  public updateExecution(): Promise<void> {
    return Promise.resolve()
  }
  public listByUser(): Promise<TaskPage<AgentTaskDefinition>> {
    return Promise.resolve({ items: [], nextCursor: '' })
  }
  public listBySession(): Promise<readonly AgentTaskDefinition[]> {
    return Promise.resolve([])
  }
  public softDeleteTask(): Promise<void> {
    return Promise.resolve()
  }
  public listExecutions(): Promise<TaskPage<AgentTaskExecution>> {
    return Promise.resolve({ items: [], nextCursor: '' })
  }
  public getExecutionById(): Promise<AgentTaskExecution | undefined> {
    return Promise.resolve(this.execution)
  }
  public markExecutionDelivered(): Promise<boolean> {
    return Promise.resolve(true)
  }
  public listUndeliveredExecutions(): Promise<readonly AgentTaskExecution[]> {
    return Promise.resolve([])
  }

  public listItemsByUser(
    userId: string,
    cursor: string,
    limit: number
  ): Promise<TaskPage<AgentTaskListItem>> {
    this.listUserId = userId
    this.listCursor = cursor
    this.listLimit = limit
    return Promise.resolve({ items: this.listItems, nextCursor: 'cursor-2' })
  }

  public listItemsBySession(
    sessionId: string,
    userId: string
  ): Promise<readonly AgentTaskListItem[]> {
    this.sessionId = sessionId
    this.sessionUserId = userId
    return Promise.resolve(this.sessionItems)
  }

  public listExecutionViewStates(
    userId: string,
    executionIds: readonly string[]
  ): Promise<readonly ExecutionViewState[]> {
    this.listUserId = userId
    this.executionIds = executionIds
    return Promise.resolve(this.viewStates)
  }

  public upsertExecutionViewState(
    userId: string,
    executionId: string,
    markSeen: boolean,
    collapsedOverride: boolean | undefined
  ): Promise<ExecutionViewState> {
    this.upsert = { userId, executionId, markSeen, collapsedOverride }
    return Promise.resolve({ executionId, collapsedOverride })
  }
}

void describe('Fastify task route parity', () => {
  void it('returns aggregated task items and forwards cursor pagination', async () => {
    const repository = new TaskRepositoryStub()
    repository.listItems = [
      {
        ...taskDefinition('USER_1'),
        sessionTitle: '项目周报',
        latestExecution: {
          executionId: 'EXEC_1',
          status: 'failed',
          scheduledAt: new Date('2026-08-28T09:30:00.000Z'),
        },
      },
    ]
    const server = await buildServer(repository)

    const response = await server.inject({
      method: 'GET',
      url: '/api/tasks?cursor=cursor-1&limit=5',
      headers: authorization(),
    })

    assert.equal(response.statusCode, 200)
    assert.equal(repository.listUserId, 'USER_1')
    assert.equal(repository.listCursor, 'cursor-1')
    assert.equal(repository.listLimit, 5)
    assert.deepEqual(response.json(), {
      code: 200,
      data: {
        tasks: [
          {
            ...wireTask(taskDefinition('USER_1')),
            session_title: '项目周报',
            latest_execution: {
              ExecutionID: 'EXEC_1',
              Status: 'failed',
              ScheduledAt: '2026-08-28T09:30:00.000Z',
              StartedAt: null,
              CompletedAt: null,
              ResultMessage: null,
              ErrorMessage: null,
            },
          },
        ],
        next_cursor: 'cursor-2',
      },
    })
    await server.close()
  })

  void it('returns null latest_execution for a session task without runs', async () => {
    const repository = new TaskRepositoryStub()
    repository.sessionItems = [
      { ...taskDefinition('USER_1'), sessionTitle: '', latestExecution: undefined },
    ]
    const server = await buildServer(repository)
    const response = await server.inject({
      method: 'GET',
      url: '/api/sessions/SESSION_1/tasks',
      headers: authorization(),
    })

    assert.equal(response.statusCode, 200)
    assert.equal(repository.sessionId, 'SESSION_1')
    assert.equal(repository.sessionUserId, 'USER_1')
    const body: unknown = response.json()
    assert.equal(JSON.stringify(body).includes('"latest_execution":null'), true)
    await server.close()
  })

  void it('deduplicates execution IDs before loading view state', async () => {
    const repository = new TaskRepositoryStub()
    repository.viewStates = [{ executionId: 'E1', seenAt: new Date('2026-08-28T09:00:00.000Z') }]
    const server = await buildServer(repository)
    const response = await server.inject({
      method: 'GET',
      url: '/api/task-execution-view-states?execution_ids=E1,%20E2,E1',
      headers: authorization(),
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(repository.executionIds, ['E1', 'E2'])
    assert.deepEqual(response.json(), {
      code: 200,
      data: {
        view_states: [
          {
            execution_id: 'E1',
            seen_at: '2026-08-28T09:00:00.000Z',
            collapsed_override: null,
            updated_at: null,
          },
        ],
      },
    })
    await server.close()
  })

  void it('preserves collapsed_override=false when updating view state', async () => {
    const repository = new TaskRepositoryStub()
    const server = await buildServer(repository)
    const response = await server.inject({
      method: 'PUT',
      url: '/api/tasks/TASK_1/executions/EXEC_1/view-state',
      headers: { ...authorization(), 'content-type': 'application/json' },
      payload: { mark_seen: true, collapsed_override: false },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(repository.upsert, {
      userId: 'USER_1',
      executionId: 'EXEC_1',
      markSeen: true,
      collapsedOverride: false,
    })
    await server.close()
  })

  void it('rejects an empty view-state patch before persistence', async () => {
    const repository = new TaskRepositoryStub()
    const server = await buildServer(repository)
    const response = await server.inject({
      method: 'PUT',
      url: '/api/tasks/TASK_1/executions/EXEC_1/view-state',
      headers: { ...authorization(), 'content-type': 'application/json' },
      payload: {},
    })

    assert.equal(response.statusCode, 400)
    assert.equal(responseCode(response.body), 4001)
    assert.equal(repository.upsert, undefined)
    await server.close()
  })

  void it('rejects a foreign task before updating view state', async () => {
    const repository = new TaskRepositoryStub()
    repository.task = taskDefinition('USER_2')
    const server = await buildServer(repository)
    const response = await server.inject({
      method: 'PUT',
      url: '/api/tasks/TASK_1/executions/EXEC_1/view-state',
      headers: { ...authorization(), 'content-type': 'application/json' },
      payload: { mark_seen: true },
    })

    assert.equal(response.statusCode, 403)
    assert.equal(responseCode(response.body), 4003)
    assert.equal(repository.upsert, undefined)
    await server.close()
  })
})

async function buildServer(repository: TaskRepositoryStub) {
  const server = createHttpServer({
    idGenerator: { generate: (prefix: string): string => `${prefix}_test` },
  })
  registerTaskRoutes(server, {
    queries: new TaskQueryService({
      taskRepository: repository,
      taskListRepository: repository,
      viewStateRepository: repository,
    }),
    commands: new TaskCommandService({
      commandRepository: repository,
      queryRepository: repository,
      viewStateRepository: repository,
    }),
    authService: new TestAuth(),
  })
  await server.ready()
  return server
}

function authorization(): { readonly authorization: string } {
  return { authorization: 'Bearer token' }
}

function taskDefinition(userId: string): AgentTaskDefinition {
  return {
    taskId: 'TASK_1',
    userId,
    sessionId: 'SESSION_1',
    taskInput: '整理今日项目进展',
    runAt: new Date('2026-08-29T09:30:00.000Z'),
    cronExpr: '',
    scheduleType: 'once',
    isActive: true,
    retryCount: 0,
    nextRunAt: new Date('2026-08-29T09:30:00.000Z'),
  }
}

function executionRecord(): AgentTaskExecution {
  const displayMessages: readonly DisplayMessage[] = []
  return {
    executionId: 'EXEC_1',
    taskId: 'TASK_1',
    sessionId: 'SESSION_1',
    status: 'completed',
    scheduledAt: new Date('2026-08-29T09:30:00.000Z'),
    displayMessages,
    delivered: false,
  }
}

function wireTask(task: AgentTaskDefinition): Record<string, unknown> {
  return {
    TaskID: task.taskId,
    UserID: task.userId,
    SessionID: task.sessionId,
    TaskInput: task.taskInput,
    RunAt: task.runAt?.toISOString(),
    CronExpr: task.cronExpr,
    ScheduleType: task.scheduleType,
    IsActive: task.isActive,
    RetryCount: task.retryCount,
    NextRunAt: task.nextRunAt?.toISOString(),
  }
}

function responseCode(body: string): unknown {
  const value: unknown = JSON.parse(body)
  return isRecord(value) ? value['code'] : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
