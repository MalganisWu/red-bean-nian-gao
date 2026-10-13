import type { ReactNode } from 'react'
import { BrandMark } from '@/components/BrandMark'

/**
 * Brand / 字标 —— 红豆年糕的品牌 mark 正式展示页。
 * 平视是一个点，近看是一枚红豆瓣。品牌色只承担识别与确认，不承担状态。
 */

/**
 * 一条带下划线的分组标题，把品牌页的展示区按语义分段。
 *
 * @param props - 组件属性；`children` 为标题文字。
 */
function Rule(props: { children: ReactNode }) {
  const { children } = props
  return (
    <div className="mb-3 flex items-center gap-2 font-sans text-label tracking-caption text-foreground-muted">
      {children}
      <span className="flex-1 border-t border-border" />
    </div>
  )
}

/**
 * 单个尺寸的字标样例：渲染该尺寸的 BrandMark 并标注像素值。
 *
 * 字标本身是单色前景，因此同一张样例在 Light / Dark 下都成立，不需要两套示例。
 *
 * @param props - 组件属性；`size` 为字标边长（像素）。
 */
function Bean(props: { size: number }) {
  const { size } = props
  return (
    <div className="flex flex-col items-center gap-2 border border-border-strong bg-card p-4">
      <BrandMark size={size} />
      <span className="font-mono text-xs text-foreground-muted">{size}px</span>
    </div>
  )
}

/** 「品牌」页：字标展示与使用边界。 */
export function BrandPage() {
  return (
    <div className="uikit-container">
      <header className="border-b border-border pb-4">
        <h1 className="font-sans text-2xl font-semibold text-foreground">品牌字标 · Brand Mark</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          平视是一个点，近看是一枚红豆瓣——圆身 + 豆脐弧线。它是字标里的那个「·」（红豆
          <span className="text-primary">·</span>年糕），不抢字、不留白。
        </p>
      </header>

      {/* 字标整体 */}
      <section>
        <Rule>字标</Rule>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="border border-border-strong bg-card p-6">
            <p className="text-label tracking-caption text-foreground-faint">大（48px）</p>
            <p className="mt-2 font-sans text-5xl font-semibold tracking-tight text-foreground">
              红豆
              <BrandMark size={40} />
              年糕
            </p>
          </div>
          <div className="border border-border-strong bg-card p-6">
            <p className="text-label tracking-caption text-foreground-faint">字标（16px）</p>
            <p className="mt-2 font-sans text-[22px] font-semibold text-foreground">
              红豆
              <BrandMark size={16} />
              年糕
            </p>
          </div>
        </div>
      </section>

      {/* 尺寸 */}
      <section>
        <Rule>尺寸</Rule>
        <div className="grid grid-cols-4 gap-4 sm:grid-cols-6">
          {[12, 14, 16, 20, 24, 32].map((s) => (
            <Bean key={s} size={s} />
          ))}
        </div>
      </section>

      <section>
        <Rule>浏览器图标</Rule>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex items-center gap-4 border border-border-strong bg-background p-4">
            <img src="/favicon.svg" alt="红豆年糕浏览器图标" className="h-8 w-8" />
            <div>
              <p className="font-sans text-[13px] font-semibold text-foreground">Light 标签页</p>
              <p className="mt-0.5 font-sans text-xs text-foreground-muted">
                豆沙红豆形 + 深色豆脐
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4 border border-border-strong bg-foreground p-4">
            <img src="/favicon.svg" alt="红豆年糕浏览器图标深色预览" className="h-8 w-8" />
            <div>
              <p className="font-sans text-[13px] font-semibold text-background">Dark 标签页</p>
              <p className="mt-0.5 font-sans text-xs text-background">
                透明底，明暗浏览器栏均可识别
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 语义配色 */}
      <section>
        <Rule>品牌与中性色</Rule>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="border border-border-strong bg-card p-4">
            <div className="h-14 w-14 rounded-none bg-brand-indicator" />
            <p className="mt-2 text-label tracking-label text-foreground-faint">主题 accent</p>
            <p className="font-mono text-xs text-foreground-body">bean · 品牌与确认</p>
          </div>
          <div className="border border-border-strong bg-card p-4">
            <div className="h-14 w-14 bg-secondary" />
            <p className="mt-2 text-label tracking-label text-foreground-faint">
              neutral · surface
            </p>
            <p className="font-mono text-xs text-foreground-body">muted · 次级表面</p>
          </div>
          <div className="border border-border-strong bg-card p-4">
            <div className="h-14 w-14 bg-brand-indicator" />
            <p className="mt-2 text-label tracking-label text-foreground-faint">红豆 · mark</p>
            <p className="font-mono text-xs text-foreground-body">primary · 随主题切换</p>
          </div>
        </div>
      </section>
    </div>
  )
}
