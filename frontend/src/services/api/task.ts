import { API_ROUTES, buildPath } from '@red-bean/api-contract'
import { apiCall } from './client'
import type {
  ExecutionViewState,
  ExecutionViewStatePatch,
  Task,
  TaskExecution,
  TaskExecutionListResponse,
  TaskListItem,
  TaskListResponse,
} from '@/types/task'
import {
  decodeEmptyEnvelope,
  decodeEnvelopeData,
  isExecutionViewStateContainer,
  isExecutionViewStatesContainer,
  isTaskContainer,
  isTaskExecutionContainer,
  isTaskExecutionListResponse,
  isTaskListContainer,
  isTaskListResponse,
} from './response-validation'

export async function fetchSessionTasks(sessionId: string): Promise<TaskListItem[]> {
  const data = await apiCall(
    buildPath(API_ROUTES.SESSION_TASKS.path, { id: sessionId }),
    {},
    (value) => decodeEnvelopeData(value, isTaskListContainer, 'session tasks')
  )
  return data.tasks
}

export async function fetchTasks(cursor?: string, limit?: number): Promise<TaskListResponse> {
  const c = cursor ?? ''
  const l = limit ?? 20
  return apiCall(
    `${API_ROUTES.TASKS.path}?cursor=${encodeURIComponent(c)}&limit=${l}`,
    {},
    (value) => decodeEnvelopeData(value, isTaskListResponse, 'task list')
  )
}

export async function fetchTask(taskId: string): Promise<Task> {
  const data = await apiCall(buildPath(API_ROUTES.TASK.path, { id: taskId }), {}, (value) =>
    decodeEnvelopeData(value, isTaskContainer, 'task detail')
  )
  // detail 端点用命名 key 包裹：data:{task}
  return data.task
}

export async function updateTask(taskId: string, isActive: boolean): Promise<void> {
  await apiCall(
    buildPath(API_ROUTES.TASK.path, { id: taskId }),
    { method: 'PUT', body: JSON.stringify({ is_active: isActive }) },
    decodeEmptyEnvelope
  )
}

export async function deleteTask(taskId: string): Promise<void> {
  await apiCall(
    buildPath(API_ROUTES.TASK.path, { id: taskId }),
    { method: 'DELETE' },
    decodeEmptyEnvelope
  )
}

export async function fetchExecutions(
  taskId: string,
  cursor?: string,
  limit?: number
): Promise<TaskExecutionListResponse> {
  const c = cursor ?? ''
  const l = limit ?? 20
  return apiCall(
    `${buildPath(API_ROUTES.TASK_EXECUTIONS.path, { id: taskId })}?cursor=${encodeURIComponent(c)}&limit=${l}`,
    {},
    (value) => decodeEnvelopeData(value, isTaskExecutionListResponse, 'task executions')
  )
}

export async function fetchExecution(taskId: string, executionId: string): Promise<TaskExecution> {
  const data = await apiCall(
    buildPath(API_ROUTES.TASK_EXECUTION.path, { id: taskId, eid: executionId }),
    {},
    (value) => decodeEnvelopeData(value, isTaskExecutionContainer, 'task execution')
  )
  // detail 端点用命名 key 包裹：data:{execution}
  return data.execution
}

export async function fetchExecutionViewStates(
  executionIds: string[]
): Promise<ExecutionViewState[]> {
  const data = await apiCall(
    `${API_ROUTES.TASK_EXECUTION_VIEW_STATES.path}?execution_ids=${encodeURIComponent(executionIds.join(','))}`,
    {},
    (value) => decodeEnvelopeData(value, isExecutionViewStatesContainer, 'execution view states')
  )
  return data.view_states
}

export async function updateExecutionViewState(
  taskId: string,
  executionId: string,
  patch: ExecutionViewStatePatch
): Promise<ExecutionViewState> {
  const data = await apiCall(
    buildPath(API_ROUTES.TASK_EXECUTION_VIEW_STATE.path, { id: taskId, eid: executionId }),
    { method: 'PUT', body: JSON.stringify(patch) },
    (value) => decodeEnvelopeData(value, isExecutionViewStateContainer, 'execution view state')
  )
  return data.view_state
}
