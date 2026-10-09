import type { DisplayMessage, MessageMeta, ScheduledTaskMeta } from './../../../agent/public-api.js'
import type { AgentTaskDefinition, AgentTaskExecution } from './../../model/task.js'

const SCHEDULED_TASK_SOURCE = 'scheduled_task'

/** 把任务执行结果投影为写入普通会话的展示消息。 */
export function buildDeliveryDisplayMessages(
  execution: AgentTaskExecution,
  task: AgentTaskDefinition,
  executionId: string,
  now: () => Date
): DisplayMessage[] {
  const meta = buildTaskMeta(execution, task, executionId)
  const assistants = execution.displayMessages
    .filter((message): boolean => message.role === 'assistant')
    .map((message): DisplayMessage => ({ ...message, source: SCHEDULED_TASK_SOURCE, meta }))
  if (assistants.length > 0) return assistants
  const content = execution.resultMessage
  const hasContent = content !== undefined && content !== ''
  const timestamp = now().valueOf()
  return [
    {
      role: 'assistant',
      ...(hasContent ? { content } : {}),
      sections: hasContent ? [{ type: 'content', content, timestamp }] : [],
      timestamp,
      source: SCHEDULED_TASK_SOURCE,
      meta,
    },
  ]
}

function buildTaskMeta(
  execution: AgentTaskExecution,
  task: AgentTaskDefinition,
  executionId: string
): MessageMeta {
  const scheduledTask: ScheduledTaskMeta = {
    taskId: task.taskId,
    taskName: task.taskInput,
    status: execution.status,
    executionId,
    scheduledAt: execution.scheduledAt.valueOf(),
    completedAt: execution.completedAt?.valueOf() ?? 0,
  }
  return { scheduledTask }
}
