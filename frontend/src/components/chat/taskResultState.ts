import type { ScheduledTaskMeta } from '@/types/chat'
import type { ExecutionViewState } from '@/types/task'

/** 定时任务结果卡片折叠判定的输入：任务状态、是否最新一轮，以及用户的手动覆盖。 */
interface DefaultCollapsedInput {
  /** 定时任务的运行状态；仅 completed 才可能自动折叠。 */
  status: ScheduledTaskMeta['status']
  /** 是否为最新一轮结果；最新结果不自动折叠，避免刚产出就被收起。 */
  isLatest: boolean
  /** 该执行的视图状态（含手动折叠覆盖与已读时间）；缺失时回落到自动规则。 */
  viewState?: ExecutionViewState | undefined
}

/**
 * 定时任务结果卡片的默认折叠态。
 * 优先级：用户的手动覆盖 > 自动规则；自动规则只在「已完成、非最新、且已被看过」时折叠——
 * 未读结果若默认收起，用户会以为任务没有产出。
 *
 * @param props - 折叠判定输入；字段语义见 `DefaultCollapsedInput`。
 * @returns 该结果卡片是否默认收起。
 */
export function getTaskResultDefaultCollapsed(props: DefaultCollapsedInput): boolean {
  const { status, isLatest, viewState } = props
  if (viewState?.collapsed_override !== null && viewState?.collapsed_override !== undefined) {
    return viewState.collapsed_override
  }
  if (status !== 'completed' || isLatest || !viewState?.seen_at) return false
  return true
}
