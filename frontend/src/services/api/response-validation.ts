/*
 * 服务层专用的「容器」守卫。
 *
 * 契约包的守卫校验的是**载荷本身**（TaskDto、TaskExecutionDto…），而接口返回的是
 * 把它们包在具名键下的对象（`{ task }`、`{ view_states }`…）。这层守卫负责剥掉外层键，
 * 让调用方拿到收窄后的载荷类型；键名写错会在编译期就暴露。
 */
import {
  isExecutionViewState,
  isRecord,
  isTask,
  isTaskExecution,
  isTaskListItem,
} from '@red-bean/api-contract'
import type {
  ExecutionViewStateDto,
  TaskDto,
  TaskExecutionDto,
  TaskListItemDto,
} from '@red-bean/api-contract'

/** 兼容现有服务层命名；字段判断由共享契约包统一执行。 */
export {
  decodeEmptyEnvelope,
  decodeEnvelopeData,
  decodeRefreshToken,
  isExecutionViewState,
  isPersistedDisplayMessage,
  isPublicUser,
  isSessionDetail,
  isSessionTrajectory,
  isTask,
  isTaskExecution,
  isTaskListItem,
  isUserList,
} from '@red-bean/api-contract'
export { isSelfUser as isUser, isToken as isTokenResponse } from '@red-bean/api-contract'
export {
  isSessionList as isSessionListResponse,
  isTaskExecutionList as isTaskExecutionListResponse,
  isTaskList as isTaskListResponse,
} from '@red-bean/api-contract'

/** 校验列表响应体：外层 `tasks` 数组，逐项过契约守卫。 */
export function isTaskListContainer(
  value: unknown
): value is { readonly tasks: TaskListItemDto[] } {
  return isRecord(value) && Array.isArray(value['tasks']) && value['tasks'].every(isTaskListItem)
}

/** 校验任务详情响应体：单任务包在 `task` 键下。 */
export function isTaskContainer(value: unknown): value is { readonly task: TaskDto } {
  return isRecord(value) && isTask(value['task'])
}

/** 校验执行详情响应体：单条执行包在 `execution` 键下。 */
export function isTaskExecutionContainer(
  value: unknown
): value is { readonly execution: TaskExecutionDto } {
  return isRecord(value) && isTaskExecution(value['execution'])
}

/** 校验批量偏好响应体：外层 `view_states` 数组。 */
export function isExecutionViewStatesContainer(
  value: unknown
): value is { readonly view_states: ExecutionViewStateDto[] } {
  return (
    isRecord(value) &&
    Array.isArray(value['view_states']) &&
    value['view_states'].every(isExecutionViewState)
  )
}

/** 校验单条偏好响应体：包在 `view_state` 键下。 */
export function isExecutionViewStateContainer(
  value: unknown
): value is { readonly view_state: ExecutionViewStateDto } {
  return isRecord(value) && isExecutionViewState(value['view_state'])
}
