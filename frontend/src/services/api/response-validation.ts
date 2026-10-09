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

export function isTaskListContainer(
  value: unknown
): value is { readonly tasks: TaskListItemDto[] } {
  return isRecord(value) && Array.isArray(value['tasks']) && value['tasks'].every(isTaskListItem)
}

export function isTaskContainer(value: unknown): value is { readonly task: TaskDto } {
  return isRecord(value) && isTask(value['task'])
}

export function isTaskExecutionContainer(
  value: unknown
): value is { readonly execution: TaskExecutionDto } {
  return isRecord(value) && isTaskExecution(value['execution'])
}

export function isExecutionViewStatesContainer(
  value: unknown
): value is { readonly view_states: ExecutionViewStateDto[] } {
  return (
    isRecord(value) &&
    Array.isArray(value['view_states']) &&
    value['view_states'].every(isExecutionViewState)
  )
}

export function isExecutionViewStateContainer(
  value: unknown
): value is { readonly view_state: ExecutionViewStateDto } {
  return isRecord(value) && isExecutionViewState(value['view_state'])
}
