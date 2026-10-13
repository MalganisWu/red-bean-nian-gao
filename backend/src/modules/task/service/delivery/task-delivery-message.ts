import type { DisplayMessage, MessageMeta, ScheduledTaskMeta } from './../../../agent/public-api.js'
import type { AgentTaskDefinition, AgentTaskExecution } from './../../model/task.js'

/** 展示消息的来源标记；前端据此把这类消息渲染成定时任务卡片而非普通助手消息。 */
const SCHEDULED_TASK_SOURCE = 'scheduled_task'

/**
 * 把任务执行结果投影为写入普通会话的展示消息。
 *
 * @param execution - 待投递的执行记录；优先沿用其 assistant 展示消息，并挂上任务元数据。
 * @param task - 任务定义，提供任务 ID 与任务名等元信息。
 * @param executionId - 执行记录标识，写入展示消息的定时任务元数据。
 * @param now - 可替换时钟（测试注入固定时刻），仅在无 assistant 消息时用于补时间戳。
 * @returns 至少一条展示消息；无 assistant 消息时合成一条带结果的占位消息。
 */
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

/**
 * 组装写入展示消息的定时任务元数据：任务名复用 taskInput，状态与时刻来自执行记录快照。
 *
 * @param execution - 执行记录，提供状态、计划与完成时刻。
 * @param task - 任务定义，提供任务 ID 与任务名。
 * @param executionId - 执行记录标识，写入元数据供前端回跳详情。
 * @returns 挂到消息上的 meta，仅含定时任务一组字段。
 */
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
