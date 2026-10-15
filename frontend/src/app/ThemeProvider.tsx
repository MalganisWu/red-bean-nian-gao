import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

/** 主题取值；仅 light / dark 两态，对应 `documentElement` 上 `dark` class 的开关。 */
type Theme = 'light' | 'dark'

/** 主题上下文的读写接口：当前主题，以及 setTheme / toggleTheme 两个动作。 */
interface ThemeContextValue {
  /** 当前生效的主题。 */
  theme: Theme
  /**
   * 显式设置主题；会同步到 documentElement 与 localStorage。
   * @param theme - 要设置的主题；仅 light / dark 两态，会同步写入 DOM 与存储。
   */
  setTheme: (theme: Theme) => void
  /** 在 light / dark 之间切换，即 setTheme 的反向操作。 */
  toggleTheme: () => void
}

/** 主题上下文；默认值 null，读取方需自行处理「不在 Provider 内」的情形（见 useTheme）。 */
const ThemeContext = createContext<ThemeContextValue | null>(null)
/** localStorage 键名；带 `rbng-` 前缀避免与同域其它应用串键，改动会让已保存主题失效。 */
const STORAGE_KEY = 'rbng-theme'

/**
 * 读取初始主题：从 localStorage 取上次保存值，非 `dark` 一律回落到 `light`。
 *
 * @returns 初始主题；首个访问或存储值非法时返回 `light`。
 */
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

  // 把当前主题同步到 `documentElement` 与 localStorage。
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
