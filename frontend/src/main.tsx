import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/globals.css'
import App from '@/app/App'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('缺少应用根节点 #root')

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
