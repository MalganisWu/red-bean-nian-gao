import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/globals.css'
import './styles/showcase.css'

/**
 * 挂载点 `#root` 由 index.html 提供；取不到说明 HTML 与入口不同步，直接抛错而不是静默白屏。
 */
const root = document.getElementById('root')
if (root === null) throw new Error('找不到 Design System 根节点 #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
