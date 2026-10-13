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

/**
 * 工具状态判据；只接受五个已登记的取值，其余一律判假。
 * @param value - 待判定的状态值；五个已登记取值之外一律判假。
 * @returns 取值合法时为 true，否则 false。
 */
function isToolStatus(value: unknown): boolean {
  return ['running', 'success', 'failed', 'cancelled', 'incomplete'].includes(String(value))
}

/**
 * 持久化工具卡片的守卫；`callId` 与 `name` 必需，其余字段可选且给了就必须合法。
 * @param value - 待判定的工具卡片；`callId` / `name` 缺一即判假，可选字段给了就必须合法。
 * @returns 形状成立时为 true，否则 false。
 */
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

/**
 * reason 项的守卫；`itemType` 必须是 step 或 tool 之一，其余字段按可选校验。
 * @param value - 待判定的 reason 项；`itemType` 取值未知即判假。
 * @returns 形状成立时为 true，否则 false。
 */
function isReasonItem(value: unknown): value is ReasonItemDto {
  if (!isRecord(value) || !['step', 'tool'].includes(String(value['itemType']))) return false
  return (
    isOptional(value['index'], isNumber) &&
    isOptional(value['content'], isString) &&
    isOptional(value['tool'], isPersistedToolCard)
  )
}

/**
 * 卡片 section 的守卫；`answers` 允许为 null 或缺省，否则须为逐项合法的作答表。
 * @param value - 待判定的卡片载荷；`interaction_id`、`status`、`questions` 任一不合法即判假。
 * @returns 形状成立时为 true，否则 false。
 */
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

/**
 * 子 Agent 状态判据；六态之外一律判假，并据此把 status 收窄为非空联合。
 * @param value - 待判定的状态值；六个已登记取值之外一律判假。
 * @returns 取值合法时为 true，否则 false。
 */
function isSubAgentStatus(
  value: unknown
): value is NonNullable<PersistedSubAgentSectionDataDto['status']> {
  return ['running', 'completed', 'failed', 'awaiting_user', 'cancelled', 'incomplete'].includes(
    String(value)
  )
}

/**
 * 子 Agent section 的守卫；四个标识与结构字段必需，`status` 等三项可选。
 * @param value - 待判定的 section 载荷；`agent_id` / `agent_name` / `execution_id` / `sections` 缺一即判假。
 * @returns 形状成立时为 true，否则 false。
 */
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

/**
 * 展示消息 section 的守卫；先取 `type` 再按类型逐分支校验，未知类型一律判假。
 * @param value - 待判定的 section；`type` 未知或对应分支的字段不合法即判假。
 * @returns 形状成立时为 true，否则 false。
 */
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

/**
 * 定时任务来源信息的守卫；`completed_at` 可选，其余字段必填。
 * @param value - 待判定的来源信息；`task_id`、`task_name`、`status`、`execution_id`、`scheduled_at` 缺一即判假。
 * @returns 形状成立时为 true，否则 false。
 */
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

/**
 * 展示元信息的守卫；三个字段全可选，给了就必须合法。
 * @param value - 待判定的元信息；三个可选字段给了就必须合法。
 * @returns 形状成立时为 true，否则 false。
 */
function isDisplayMessageMeta(value: unknown): value is DisplayMessageMetaDto {
  return (
    isRecord(value) &&
    isOptional(value['scheduled_task'], isScheduledTaskMeta) &&
    isOptional(value['run_started_at'], isNumber) &&
    isOptional(value['process_status'], (status): status is 'cancelled' => status === 'cancelled')
  )
}

/**
 * 持久化展示消息的守卫；`sections` 与 `meta` 可选，但给了就必须逐层合法。
 * @param value - 待判定的展示消息；`role` 与 `timestamp` 必需，可选字段给了就必须逐层合法。
 * @returns 形状成立时为 true，否则 false（不抛错、不做兼容填充）。
 */
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
