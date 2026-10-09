import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from '@/app/ThemeProvider'
import { Toaster } from '@/components/retroui/Sonner'
import { Tooltip } from '@/components/retroui/Tooltip'
import { Routes } from '@/app/routes'

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
