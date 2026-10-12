import { Moon, Sun } from 'lucide-react'

import { useTheme } from '@/app/ThemeProvider'

/** 明暗主题切换按钮；当前态经 `aria-pressed` 与无障碍名称对外表达。 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === 'dark'

  return (
    <button
      type="button"
      aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
      aria-pressed={isDark}
      onClick={toggleTheme}
      className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 bg-transparent px-1 text-xs text-foreground-muted transition-colors hover:text-foreground"
    >
      {isDark ? (
        <Sun aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.35} />
      ) : (
        <Moon aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.35} />
      )}
      <span>{isDark ? '浅色' : '深色'}</span>
    </button>
  )
}
