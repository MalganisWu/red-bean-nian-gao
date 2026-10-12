import type {
  CardSectionDataDto,
  DisplayMessageMetaDto,
  PersistedDisplayMessageDto,
  PersistedMessageSectionDto,
  PersistedSubAgentSectionDataDto,
  PersistedToolCardDto,
  ReasonItemDto,
  ScheduledTaskMetaDto,
} from './dto.js'
import { isQuestion, isQuestionAnswer } from '../chat/schema.js'
import { isArrayOf, isNumber, isOptional, isRecord, isString } from '../common/schema.js'

function isToolStatus(value: unknown): boolean {
  return ['running', 'success', 'failed', 'cancelled', 'incomplete'].includes(String(value))
}

function isPersistedToolCard(value: unknown): value is PersistedToolCardDto {
  if (!isRecord(value) || !isString(value['callId']) || !isString(value['name'])) return false
  return (
    isToolStatus(value['status']) &&
    isOptional(value['label'], isString) &&
    isOptional(value['params'], isString) &&
    isOptional(value['result'], isString) &&
    isOptional(value['error'], isString) &&
    isOptional(
      value['duration'],
      (duration): duration is string | number => isString(duration) || isNumber(duration)
    ) &&
    isOptional(value['durationMs'], isNumber) &&
    isOptional(value['startedAtMs'], isNumber)
  )
}

function isReasonItem(value: unknown): value is ReasonItemDto {
  if (!isRecord(value) || !['step', 'tool'].includes(String(value['itemType']))) return false
  return (
    isOptional(value['index'], isNumber) &&
    isOptional(value['content'], isString) &&
    isOptional(value['tool'], isPersistedToolCard)
  )
}

function isCardSectionData(value: unknown): value is CardSectionDataDto {
  if (
    !isRecord(value) ||
    !isString(value['interaction_id']) ||
    !['pending', 'answered', 'refused'].includes(String(value['status'])) ||
    !isArrayOf(value['questions'], isQuestion)
  ) {
    return false
  }
  const answers = value['answers']
  return (
    answers === null ||
    answers === undefined ||
    (isRecord(answers) && Object.values(answers).every(isQuestionAnswer))
  )
}

function isSubAgentStatus(
  value: unknown
): value is NonNullable<PersistedSubAgentSectionDataDto['status']> {
  return ['running', 'completed', 'failed', 'awaiting_user', 'cancelled', 'incomplete'].includes(
    String(value)
  )
}

function isSubAgentSectionData(value: unknown): value is PersistedSubAgentSectionDataDto {
  if (
    !isRecord(value) ||
    !isString(value['agent_id']) ||
    !isString(value['agent_name']) ||
    !isString(value['execution_id']) ||
    !isArrayOf(value['sections'], isPersistedMessageSection)
  ) {
    return false
  }
  return (
    isOptional(value['status'], isSubAgentStatus) &&
    isOptional(value['result_summary'], isString) &&
    isOptional(value['parent_call_id'], isString)
  )
}

function isPersistedMessageSection(value: unknown): value is PersistedMessageSectionDto {
  if (!isRecord(value) || !isNumber(value['timestamp'])) return false
  switch (value['type']) {
    case 'reason':
      return isOptional(value['duration'], isNumber) && isArrayOf(value['items'], isReasonItem)
    case 'tool_group':
      return (
        isOptional(value['duration'], isNumber) && isArrayOf(value['tools'], isPersistedToolCard)
      )
    case 'content':
      return isOptional(value['duration'], isNumber) && isString(value['content'])
    case 'card':
      return isCardSectionData(value['card'])
    case 'sub_agent':
      return isSubAgentSectionData(value['items'])
    default:
      return false
  }
}

function isScheduledTaskMeta(value: unknown): value is ScheduledTaskMetaDto {
  return (
    isRecord(value) &&
    isString(value['task_id']) &&
    isString(value['task_name']) &&
    ['completed', 'failed'].includes(String(value['status'])) &&
    isString(value['execution_id']) &&
    isNumber(value['scheduled_at']) &&
    isOptional(value['completed_at'], isNumber)
  )
}

function isDisplayMessageMeta(value: unknown): value is DisplayMessageMetaDto {
  return (
    isRecord(value) &&
    isOptional(value['scheduled_task'], isScheduledTaskMeta) &&
    isOptional(value['run_started_at'], isNumber) &&
    isOptional(value['process_status'], (status): status is 'cancelled' => status === 'cancelled')
  )
}

/** 持久化展示消息的守卫；`sections` 与 `meta` 可选，但给了就必须逐层合法。 */
export function isPersistedDisplayMessage(value: unknown): value is PersistedDisplayMessageDto {
  if (
    !isRecord(value) ||
    !['user', 'assistant'].includes(String(value['role'])) ||
    !isNumber(value['timestamp'])
  ) {
    return false
  }
  return (
    isOptional(value['content'], isString) &&
    isOptional(value['sections'], (items): items is PersistedMessageSectionDto[] =>
      isArrayOf(items, isPersistedMessageSection)
    ) &&
    isOptional(value['source'], isString) &&
    isOptional(value['meta'], isDisplayMessageMeta)
  )
}
