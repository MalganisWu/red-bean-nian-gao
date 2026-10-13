import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge 默认只认识内置字号（`text-xs`/`text-sm`/…），**不认识本仓 `@theme` 里的
 * 自定义字号**（`--text-label`）。于是 `cn('text-label', 'text-success-text')` 会被判成
 * 「同组冲突」而**静默丢掉 `text-label`**——表现为**带状态色的 chip 比身份 chip 大一号**
 * （实测终态 chip 16px 字 / 24px 高，身份 chip 12px 字 / 20px 高）。
 * 它只在少数分支出现，极易被误判成「样式没对齐」而不是丢了类名。
 *
 * 把自定义字号登记进 `font-size` 组后，冲突判定正确，字号与文字颜色各自独立保留。
 * **新增自定义 `--text-*` 字号时必须同步登记到下面这个列表。**
 */
const CUSTOM_FONT_SIZES = ['label'] as const

/**
 * 本仓专用的合并器：在 tailwind-merge 默认配置上补齐自定义 `--text-*` 字号后再交给 `cn`。
 * 只有登记进 `font-size` 组的字号才会与文字颜色分开裁决，未被登记的会在同组冲突里被
 * **静默丢弃**——这正是上面那段注释记录的坑。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: [...CUSTOM_FONT_SIZES] }],
    },
  },
})

/**
 * 合并 className：clsx 处理条件分支，tailwind-merge 消解同组冲突。
 * @param inputs clsx 可接受的任意类名输入
 * @returns 去重合并后的 className
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
