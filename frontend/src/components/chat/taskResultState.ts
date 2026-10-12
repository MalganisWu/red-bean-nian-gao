import type { ScheduledTaskMeta } from '@/types/chat'
import type { ExecutionViewState } from '@/types/task'

interface DefaultCollapsedInput {
  status: ScheduledTaskMeta['status']
  isLatest: boolean
  viewState?: ExecutionViewState | undefined
}

/**
 * 定时任务结果卡片的默认折叠态。
 * 优先级：用户的手动覆盖 > 自动规则；自动规则只在「已完成、非最新、且已被看过」时折叠——
 * 未读结果若默认收起，用户会以为任务没有产出。
 */
export function getTaskResultDefaultCollapsed({
  status,
  isLatest,
  viewState,
}: DefaultCollapsedInput): boolean {
  if (viewState?.collapsed_override !== null && viewState?.collapsed_override !== undefined) {
    return viewState.collapsed_override
  }
  if (status !== 'completed' || isLatest || !viewState?.seen_at) return false
  return true
}
