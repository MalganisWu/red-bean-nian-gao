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

/**
 * 读取某会话下的任务列表（已解包 `tasks` 外层）。
 *
 * @param sessionId - 会话标识，经 buildPath 填入路由模板；响应经 isTaskListContainer 校验后取 tasks。
 * @returns 该会话的任务列表项数组。
 */
export async function fetchSessionTasks(sessionId: string): Promise<TaskListItem[]> {
  const data = await apiCall(
    buildPath(API_ROUTES.SESSION_TASKS.path, { id: sessionId }),
    {},
    (value) => decodeEnvelopeData(value, isTaskListContainer, 'session tasks')
  )
  return data.tasks
}

/**
 * 分页拉取任务列表；游标与条数缺省时落到默认值（空串 / 20）。
 *
 * @param cursor - 上一页返回的游标；缺省空串表示从最新一页开始。
 * @param limit - 单页条数，缺省 20；响应经 isTaskListResponse 校验后收窄为 TaskListResponse。
 * @returns 一页任务列表（含下一页游标）。
 */
export async function fetchTasks(cursor?: string, limit?: number): Promise<TaskListResponse> {
  const c = cursor ?? ''
  const l = limit ?? 20
  return apiCall(
    `${API_ROUTES.TASKS.path}?cursor=${encodeURIComponent(c)}&limit=${l}`,
    {},
    (value) => decodeEnvelopeData(value, isTaskListResponse, 'task list')
  )
}

/**
 * 按 id 读取单条任务详情（已剥掉 `task` 外层命名键）。
 *
 * @param taskId - 任务标识，经 buildPath 填入路由模板；响应经 isTaskContainer 校验后取 task。
 * @returns 任务详情。
 */
export async function fetchTask(taskId: string): Promise<Task> {
  const data = await apiCall(buildPath(API_ROUTES.TASK.path, { id: taskId }), {}, (value) =>
    decodeEnvelopeData(value, isTaskContainer, 'task detail')
  )
  // detail 端点用命名 key 包裹：data:{task}
  return data.task
}

/**
 * 启用或停用某条任务；以 PUT 提交 is_active。
 *
 * @param taskId - 任务标识，经 buildPath 填入路由模板。
 * @param isActive - 目标启用状态；true 启用、false 停用。
 */
export async function updateTask(taskId: string, isActive: boolean): Promise<void> {
  await apiCall(
    buildPath(API_ROUTES.TASK.path, { id: taskId }),
    { method: 'PUT', body: JSON.stringify({ is_active: isActive }) },
    decodeEmptyEnvelope
  )
}

/**
 * 删除某条任务；成功与否由抛错体现，无返回值。
 *
 * @param taskId - 任务标识，经 buildPath 填入路由模板。
 */
export async function deleteTask(taskId: string): Promise<void> {
  await apiCall(
    buildPath(API_ROUTES.TASK.path, { id: taskId }),
    { method: 'DELETE' },
    decodeEmptyEnvelope
  )
}

/**
 * 分页拉取某任务下的执行记录；游标与条数缺省时落到默认值（空串 / 20）。
 *
 * @param taskId - 任务标识，经 buildPath 填入路由模板。
 * @param cursor - 上一页返回的游标；缺省空串表示从最新一页开始。
 * @param limit - 单页条数，缺省 20；响应经 isTaskExecutionListResponse 校验后收窄。
 * @returns 一页执行记录列表（含下一页游标）。
 */
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

/**
 * 读取单条执行详情（已剥掉 `execution` 外层命名键）。
 *
 * @param taskId - 所属任务标识，经 buildPath 填入路由模板。
 * @param executionId - 执行标识，与 taskId 一起填入路由模板；响应经 isTaskExecutionContainer 校验后取 execution。
 * @returns 执行详情。
 */
export async function fetchExecution(taskId: string, executionId: string): Promise<TaskExecution> {
  const data = await apiCall(
    buildPath(API_ROUTES.TASK_EXECUTION.path, { id: taskId, eid: executionId }),
    {},
    (value) => decodeEnvelopeData(value, isTaskExecutionContainer, 'task execution')
  )
  // detail 端点用命名 key 包裹：data:{execution}
  return data.execution
}

/**
 * 批量读取多条执行的偏好视图状态（已解包 `view_states` 外层）。
 *
 * @param executionIds - 待查询的执行标识数组；以逗号拼接进查询串，空数组会请求到空结果。
 * @returns 各执行的偏好视图状态数组。
 */
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

/**
 * 更新单条执行的偏好视图状态（已剥掉 `view_state` 外层命名键）。
 *
 * @param taskId - 所属任务标识，经 buildPath 填入路由模板。
 * @param executionId - 执行标识，与 taskId 一起填入路由模板。
 * @param patch - 待更新的偏好字段；以 PUT 提交，响应经 isExecutionViewStateContainer 校验后取 view_state。
 * @returns 更新后的偏好视图状态。
 */
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
