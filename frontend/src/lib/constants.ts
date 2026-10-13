// ── 路由路径 ──────────────────────────────────────────
/** 路由路径表；与 React Router 声明一一对应，组件跳转统一引用此处避免路径字面量散落。 */
export const ROUTES = {
  HOME: '/',
  CHAT: '/chat',
  LOGIN: '/login',
  REGISTER: '/register',
  PROFILE: '/profile',
  TASKS: '/tasks',
  TASK_DETAIL: '/tasks/:id',
  TASK_EXECUTION_DETAIL: '/tasks/:id/executions/:eid',
}

// ── Token 存储 ────────────────────────────────────────
/** localStorage 中访问令牌的键名；读写必须共用此常量，避免键名前缀漂移导致令牌丢失。 */
export const TOKEN_KEY = 'red_bean_token'

// ── 默认 Agent ────────────────────────────────────────
/** 未显式指定 Agent 时使用的默认标识，需与后端 seed 的默认 Agent id 对齐。 */
export const DEFAULT_AGENT_ID = 'default'
