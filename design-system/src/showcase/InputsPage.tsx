import type { ReactNode } from 'react'

import { Input } from '@/components/Input'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

/** 字段样例 Props：标签、可选提示与控件本体。 */
interface FieldExampleProps {
  /** 字段名，渲染为控件上方的标签文字。 */
  label: string
  /** 校验或补充提示；缺省时不渲染提示行。 */
  hint?: string
  /** 被展示的输入控件。 */
  children: ReactNode
}

/**
 * 单个输入字段样例：标签、控件与可选提示竖直排列。
 *
 * 提示使用失败红，与其配对的控件错误态同色；两套主题下均由语义色令牌取值。
 *
 * @param props - 组件属性；字段语义见 `FieldExampleProps`。
 * @returns 该字段样例渲染出的元素。
 */
function FieldExample(props: FieldExampleProps): React.ReactElement {
  const { label, hint, children } = props
  return (
    <label className="grid gap-1.5 font-sans text-xs text-foreground-muted">
      <span>{label}</span>
      {children}
      {hint && <span className="leading-normal text-danger">ⓘ {hint}</span>}
    </label>
  )
}

/**
 * 「输入框」组件页：字段、提示与校验态的示例。
 *
 * @returns 该组件页渲染出的元素。
 */
export function InputsPage(): React.ReactElement {
  return (
    <div className="conversation-showcase">
      <SpecPageHeader
        title="输入框 · Input"
        description="统一 40px 高度；焦点只使用豆沙红，错误只使用失败红。"
        note="提示与错误必须有文字，不只依靠颜色表达。"
      />

      <section className="spec-section">
        <h3 className="spec-section__title">Default / focus / error / disabled</h3>
        <div className="grid max-w-xl gap-4 border-y border-border-strong py-5">
          <FieldExample label="默认">
            <Input defaultValue="整理产品动态" aria-label="默认输入" />
          </FieldExample>
          <FieldExample label="聚焦">
            <Input
              defaultValue="工作日 18:30"
              aria-label="聚焦输入示例"
              className="border-brand-text ring-2 ring-focus-ring ring-offset-1 ring-offset-background"
            />
          </FieldExample>
          <FieldExample label="错误" hint="请输入正确的地址">
            <Input defaultValue="team.example" aria-label="错误输入" aria-invalid />
          </FieldExample>
          <FieldExample label="禁用">
            <Input defaultValue="默认工作区" aria-label="禁用输入" disabled />
          </FieldExample>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Rules</h3>
        <div className="spec-rule-grid">
          <div>
            <strong>Geometry</strong>
            <p>40px 高、8px 圆角、12px 水平内边距。</p>
          </div>
          <div>
            <strong>Focus</strong>
            <p>深豆沙边框配不透明 2px focus ring，并与控件边界留出 1px 间隔。</p>
          </div>
          <div>
            <strong>Error</strong>
            <p>鲜红边框与明确错误文案，不加入品牌色。</p>
          </div>
          <div>
            <strong>Disabled</strong>
            <p>muted 表面和弱文字，同时保留可读性。</p>
          </div>
        </div>
      </section>
    </div>
  )
}
