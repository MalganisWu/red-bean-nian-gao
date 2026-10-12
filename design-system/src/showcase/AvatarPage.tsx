import { ChevronUp } from 'lucide-react'

import { Avatar } from '@/components/Avatar'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

/** 「头像」组件页：尺寸档位与中性回退形态。 */
export function AvatarPage(): React.ReactElement {
  return (
    <div className="conversation-showcase">
      <SpecPageHeader
        title="头像 · Avatar"
        description="圆形中性回退，不使用随机渐变、品牌色铺底或虚假的在线状态。"
        note="24px 用于紧凑账户行，32px 为默认，40px 用于更宽松的身份场景。"
      />

      <section className="spec-section">
        <h3 className="spec-section__title">24 / 32 / 40</h3>
        <div className="flex items-center gap-3 border-y border-border-strong py-5">
          <Avatar className="h-6 w-6">
            <Avatar.Fallback className="text-[10px]">张</Avatar.Fallback>
          </Avatar>
          <Avatar>
            <Avatar.Fallback>林</Avatar.Fallback>
          </Avatar>
          <Avatar className="h-10 w-10">
            <Avatar.Fallback className="text-[13px]">周</Avatar.Fallback>
          </Avatar>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Account row</h3>
        <button
          type="button"
          className="grid w-full max-w-xs cursor-pointer grid-cols-[32px_minmax(0,1fr)_16px] items-center gap-2.5 border-y border-border bg-transparent py-2.5 text-left hover:bg-surface-hover"
        >
          <Avatar>
            <Avatar.Fallback>张</Avatar.Fallback>
          </Avatar>
          <span className="min-w-0">
            <strong className="block truncate font-sans text-[13px] font-semibold text-foreground">
              张三
            </strong>
            <span className="mt-0.5 block truncate font-sans text-xs text-foreground-muted">
              san.zhang
            </span>
          </span>
          <ChevronUp aria-hidden="true" className="h-3.5 w-3.5 text-foreground-faint" />
        </button>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Rules</h3>
        <div className="spec-rule-grid">
          <div>
            <strong>Fallback</strong>
            <p>取显示名或用户名首字，中性背景和细边框。</p>
          </div>
          <div>
            <strong>Identity</strong>
            <p>头像旁必须同时显示名称；需要时补充用户名。</p>
          </div>
          <div>
            <strong>Privacy</strong>
            <p>Showcase 与 Mock 只使用虚构身份，不出现真实姓名、用户名或邮箱。</p>
          </div>
        </div>
      </section>
    </div>
  )
}
