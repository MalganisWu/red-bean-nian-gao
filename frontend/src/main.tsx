import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/globals.css'
import App from '@/app/App'

/** 应用挂载点；约定为 index.html 中的 #root，缺失即视为构建配置损坏并直接抛错。 */
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('缺少应用根节点 #root')

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
