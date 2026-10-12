import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from '@/app/ThemeProvider'
import { Toaster } from '@/components/retroui/Sonner'
import { Tooltip } from '@/components/retroui/Tooltip'
import { Routes } from '@/app/routes'

/** 应用根组件：主题、路由、Tooltip 与全局 Toast 的装配点。 */
export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Tooltip.Provider delay={400}>
          <Routes />
          <Toaster />
        </Tooltip.Provider>
      </BrowserRouter>
    </ThemeProvider>
  )
}

export default App
