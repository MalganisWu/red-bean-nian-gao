import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type Theme = 'light' | 'dark'

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)
const STORAGE_KEY = 'rbng-theme'

function initialTheme(): Theme {
  const saved = window.localStorage.getItem(STORAGE_KEY)
  return saved === 'dark' ? 'dark' : 'light'
}

/**
 * 主题上下文；把主题同步到 `documentElement` 与 localStorage，刷新后保持。
 *
 * @param props - 主题 Provider 的属性；children 是会读取主题的子树，初始主题取自 localStorage（非 dark 一律回落到 light）。
 */
export function ThemeProvider(props: { children: ReactNode }) {
  const { children } = props
  const [theme, setTheme] = useState<Theme>(initialTheme)

  /** 把当前主题同步到 `documentElement` 与 localStorage。 */
  function applyTheme(): void {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    window.localStorage.setItem(STORAGE_KEY, theme)
  }

  useEffect(applyTheme, [theme])

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        toggleTheme: () => setTheme((current) => (current === 'dark' ? 'light' : 'dark')),
      }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

// Hook 与 Provider 共同构成一个很小的主题边界，刻意共址。
/**
 * 读取当前主题上下文；仅可在 `ThemeProvider` 内调用。
 *
 * 脱离 Provider 时直接抛错而非给默认值：静默回落到亮色会掩盖误用，宁可快速失败暴露。
 *
 * @returns 当前主题及 setTheme / toggleTheme 两个动作。
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return value
}
