import { Copy, History, MoreHorizontal, Trash2 } from 'lucide-react'

import { Menu } from '@/components/Menu'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

const triggerClassName =
  'flex min-h-11 min-w-48 cursor-pointer items-center justify-between rounded-md border border-border-strong bg-background px-3 font-sans text-xs font-medium text-foreground-body hover:border-foreground-faint hover:text-foreground sm:min-h-9'

export function MenuPage(): React.ReactElement {
  return (
    <div className="conversation-showcase">
      <SpecPageHeader
        title="菜单 · Menu"
        description="菜单是少数允许使用浮层阴影的组件；边界清楚，条目保持紧凑。"
        note="危险项默认仍为中性色，只在 hover / focus 时显示失败红。"
      />

      <section className="spec-section">
        <h3 className="spec-section__title">Default</h3>
        <div className="min-h-56 border-y border-border-strong py-5">
          <Menu defaultOpen>
            <Menu.Trigger className={triggerClassName}>
              更多操作
              <MoreHorizontal aria-hidden="true" className="h-4 w-4" strokeWidth={1.7} />
            </Menu.Trigger>
            <Menu.Content>
              <Menu.Item>
                <Copy aria-hidden="true" className="h-3.5 w-3.5 text-foreground-muted" />
                复制任务
              </Menu.Item>
              <Menu.Item>
                <History aria-hidden="true" className="h-3.5 w-3.5 text-foreground-muted" />
                查看执行记录
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item className="hover:text-danger focus:text-danger">
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                删除任务
              </Menu.Item>
            </Menu.Content>
          </Menu>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Rules</h3>
        <div className="spec-rule-grid">
          <div>
            <strong>Container</strong>
            <p>1px strong border、8px 圆角和唯一一档 overlay shadow。</p>
          </div>
          <div>
            <strong>Item</strong>
            <p>34px 桌面高度；6px 内圆角；hover 使用中性灰表面。</p>
          </div>
          <div>
            <strong>Danger confirmation</strong>
            <p>首次选择只进入确认态并说明影响范围；第二次确认才提交删除。</p>
          </div>
          <div>
            <strong>Pending</strong>
            <p>提交期间原位显示“正在删除…”，只锁定当前危险动作。</p>
          </div>
        </div>
      </section>
    </div>
  )
}
