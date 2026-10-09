import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/globals.css'
import './styles/showcase.css'

const root = document.getElementById('root')
if (root === null) throw new Error('找不到 Design System 根节点 #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
