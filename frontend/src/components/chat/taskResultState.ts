import type { ScheduledTaskMeta } from '@/types/chat'
import type { ExecutionViewState } from '@/types/task'

interface DefaultCollapsedInput {
  status: ScheduledTaskMeta['status']
  isLatest: boolean
  viewState?: ExecutionViewState | undefined
}

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
