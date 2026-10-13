import { MoreHorizontal } from 'lucide-react'

import { Menu } from '@/components/retroui/Menu'

/** 任务操作菜单属性：标题用于确认文案，删除走二次确认，删除进行中时整体禁用交互。 */
interface TaskActionsMenuProps {
  /** 任务标题；用于二次确认文案，让用户确认删的是哪一条。 */
  taskTitle: string
  /** 是否处于删除二次确认态；为 true 时展示确认项。 */
  confirmingDelete?: boolean
  /** 删除请求是否进行中；为 true 时禁用整个菜单交互。 */
  deleting?: boolean
  /** 确认删除时触发；实际删除由调用方执行。 */
  onDelete: () => void
}

/**
 * 任务卡片的操作菜单；删除走二次确认，删除进行中时禁用交互。
 *
 * @param props - 组件属性；字段语义见 `TaskActionsMenuProps`。
 */
export function TaskActionsMenu(props: TaskActionsMenuProps) {
  const { taskTitle, confirmingDelete = false, deleting = false, onDelete } = props
  if (deleting) {
    return (
      <span
        role="status"
        className="inline-flex min-h-11 items-center font-sans text-xs text-danger sm:min-h-9"
      >
        正在删除…
      </span>
    )
  }

  return (
    <Menu>
      <Menu.Trigger
        aria-label={`${taskTitle}的更多操作`}
        className="grid h-9 w-9 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <MoreHorizontal aria-hidden="true" className="h-4 w-4" strokeWidth={1.5} />
      </Menu.Trigger>
      <Menu.Content className="p-1">
        <Menu.Item className="text-danger focus:text-danger" onClick={onDelete}>
          {confirmingDelete ? `确认删除“${taskTitle}”？` : '删除任务'}
        </Menu.Item>
        {confirmingDelete && !deleting && (
          <p className="m-0 max-w-56 px-2.5 pb-2 pt-1 font-sans text-xs leading-[1.55] text-foreground-muted">
            删除后停止后续执行；历史执行记录仍保留。
          </p>
        )}
      </Menu.Content>
    </Menu>
  )
}
