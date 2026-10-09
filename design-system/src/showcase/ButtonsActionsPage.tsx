import { MoreHorizontal } from 'lucide-react'

import { Button } from '@/components/Button'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

export function ButtonsActionsPage(): React.ReactElement {
  return (
    <div className="conversation-showcase">
      <SpecPageHeader
        title="按钮 · Button"
        description="确认用豆沙红文字，普通动作使用中性描边，强提交动作才使用中性实心。"
        note="颜色表达动作语义，不把所有按钮做成品牌色填充。"
      />

      <section className="spec-section">
        <h3 className="spec-section__title">Common actions</h3>
        <div className="flex flex-wrap items-center gap-3 border-y border-border-strong py-5">
          <Button>确认</Button>
          <Button variant="outline">新建任务</Button>
          <Button variant="ghost">稍后处理</Button>
          <Button variant="destructive">删除</Button>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Strong / icon / disabled</h3>
        <div className="flex flex-wrap items-center gap-3 border-y border-border-strong py-5">
          <Button variant="solid">登录</Button>
          <Button variant="ghost" size="icon" aria-label="更多">
            <MoreHorizontal aria-hidden="true" className="h-4 w-4" strokeWidth={1.7} />
          </Button>
          <Button variant="outline" disabled>
            不可用
          </Button>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Async action</h3>
        <div className="flex flex-wrap items-center gap-4 border-y border-border-strong py-5">
          <Button disabled aria-busy="true">
            正在保存…
          </Button>
          <span className="text-xs text-foreground-muted">
            pending 保持原位置与动作语义，只锁定当前操作。
          </span>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Sizes</h3>
        <div className="flex flex-wrap items-center gap-3 border-y border-border-strong py-5">
          <Button variant="outline" size="sm">
            Small
          </Button>
          <Button variant="outline">Medium</Button>
          <Button variant="outline" size="lg">
            Large
          </Button>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Compatibility variants</h3>
        <div className="flex flex-wrap items-center gap-3 border-y border-border-strong py-5">
          <Button variant="secondary">次级按钮</Button>
          <Button variant="destructive-outline">危险描边</Button>
          <Button variant="link">文字链接</Button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-foreground-faint">
          为既有调用保留；新界面优先使用上方五种动作层级。
        </p>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Rules</h3>
        <div className="spec-rule-grid">
          <div>
            <strong>Confirm</strong>
            <p>保存、继续、立即测试：无填充豆沙红文字。</p>
          </div>
          <div>
            <strong>Solid</strong>
            <p>登录、注册等唯一强提交动作：前景色中性实心。</p>
          </div>
          <div>
            <strong>Outline / Ghost</strong>
            <p>普通或次级动作使用描边与透明背景。</p>
          </div>
          <div>
            <strong>Danger</strong>
            <p>删除等危险动作使用失败红文字；先说明影响并二次确认，不默认填充。</p>
          </div>
        </div>
      </section>
    </div>
  )
}
