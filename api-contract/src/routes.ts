/** HTTP method 与路径模板共同构成稳定的公开路由标识。 */
export interface ApiRouteDefinition {
  readonly method: 'DELETE' | 'GET' | 'POST' | 'PUT'
  readonly path: string
  readonly authenticated: boolean
}

/**
 * 全仓唯一的接口路径事实来源：路径文本只允许出现在本命名表。
 * 模板语法一律使用 Fastify 原生形式（`:param`、通配 `*`），`{xxx}` 只允许出现在文档展示投影。
 * 命名规则（AGENTS.md）：
 * - R1：同一父路径下，同一深度禁止静态段与参数段并存；
 * - R2：跨资源/系统级查询不借集合前缀，上提为顶层资源；
 * - R3：id 值域限 uuid/数字，静态段用连字符名词复数。
 */
export const API_ROUTES = {
  /** 部署探针，裸响应不套信封。 */
  HEALTH: { method: 'GET', path: '/health', authenticated: false },
  /** 部署就绪探针，裸响应不套信封。 */
  READYZ: { method: 'GET', path: '/readyz', authenticated: false },
  /** 部署版本信息，裸响应不套信封。 */
  VERSION: { method: 'GET', path: '/version', authenticated: false },
  /** 用户注册（注册限流）。 */
  REGISTER: { method: 'POST', path: '/api/register', authenticated: false },
  /** 登录换取 token（登录限流）。 */
  LOGIN: { method: 'POST', path: '/api/login', authenticated: false },
  /** 登出，Bearer 自行解析。 */
  LOGOUT: { method: 'POST', path: '/api/logout', authenticated: false },
  /** 刷新 token，Bearer 自行解析。 */
  REFRESH: { method: 'POST', path: '/api/refresh', authenticated: false },
  /** multipart 上传对象。 */
  STORAGE_UPLOAD: { method: 'POST', path: '/api/storage/upload', authenticated: true },
  /**
   * 下载对象。通配 `*` 是 Fastify 原生 splat，可匹配含斜杠的对象 key
   * （如 `uploads/user-1/1726000000000.png`）；请求参数键为 `'*'`，
   * 见 `api-contract/src/storage/schema.ts` 的 `objectPathSchema`。
   */
  STORAGE_DOWNLOAD: { method: 'GET', path: '/api/storage/download/*', authenticated: true },
  /** 删除对象，路径语义同 STORAGE_DOWNLOAD。 */
  STORAGE_OBJECTS: { method: 'DELETE', path: '/api/storage/objects/*', authenticated: true },
  /** 生成下载预签名 URL。 */
  STORAGE_PRESIGN_GET: { method: 'POST', path: '/api/storage/presign/get', authenticated: true },
  /** 生成上传预签名 URL。 */
  STORAGE_PRESIGN_PUT: { method: 'POST', path: '/api/storage/presign/put', authenticated: true },
  /** 启动流式对话。 */
  CHAT: { method: 'POST', path: '/api/agent/chat', authenticated: true },
  /** 取消进行中的对话。 */
  CHAT_CANCEL: { method: 'POST', path: '/api/agent/chat/cancel', authenticated: true },
  /** 回答 interrupt 等待中的对话（含 card 提交）。 */
  CHAT_ANSWER: { method: 'POST', path: '/api/agent/chat/answer', authenticated: true },
  /** 会话列表。 */
  SESSIONS: { method: 'GET', path: '/api/sessions', authenticated: true },
  /** 会话详情。 */
  SESSION: { method: 'GET', path: '/api/sessions/:id', authenticated: true },
  /** 会话下的定时任务列表。 */
  SESSION_TASKS: { method: 'GET', path: '/api/sessions/:id/tasks', authenticated: true },
  /** 会话轨迹（只读审计视图：轮次化记录 + 泳道概览数据）。 */
  SESSION_TRAJECTORY: { method: 'GET', path: '/api/sessions/:id/trajectory', authenticated: true },
  /** 定时任务列表。 */
  TASKS: { method: 'GET', path: '/api/tasks', authenticated: true },
  /** 定时任务详情。 */
  TASK: { method: 'GET', path: '/api/tasks/:id', authenticated: true },
  /** 更新定时任务。 */
  TASK_UPDATE: { method: 'PUT', path: '/api/tasks/:id', authenticated: true },
  /** 删除定时任务。 */
  TASK_DELETE: { method: 'DELETE', path: '/api/tasks/:id', authenticated: true },
  /**
   * 批量读取执行结果的已读与折叠状态（跨任务查询，query 传 execution_ids）。
   * 生命周期：原 `/api/tasks/execution-view-states`（静态段与 `:id` 同深度冲突），
   * 按 R2 上提为顶层资源。
   */
  TASK_EXECUTION_VIEW_STATES: {
    method: 'GET',
    path: '/api/task-execution-view-states',
    authenticated: true,
  },
  /** 任务执行记录列表。 */
  TASK_EXECUTIONS: { method: 'GET', path: '/api/tasks/:id/executions', authenticated: true },
  /** 单条执行记录。 */
  TASK_EXECUTION: {
    method: 'GET',
    path: '/api/tasks/:id/executions/:eid',
    authenticated: true,
  },
  /** 更新单条执行记录的已读/折叠视图状态。 */
  TASK_EXECUTION_VIEW_STATE: {
    method: 'PUT',
    path: '/api/tasks/:id/executions/:eid/view-state',
    authenticated: true,
  },
  /** 当前用户资料。 */
  ME: { method: 'GET', path: '/api/me', authenticated: true },
  /** 更新当前用户资料。 */
  ME_UPDATE: { method: 'PUT', path: '/api/me', authenticated: true },
  /** 用户详情。 */
  USER: { method: 'GET', path: '/api/users/:id', authenticated: true },
  /** 用户列表。 */
  USERS: { method: 'GET', path: '/api/users', authenticated: true },
} as const satisfies Record<string, ApiRouteDefinition>

/**
 * 渲染路径模板中的 `:param` 占位符；未提供的占位符原样保留。
 * 通配 `*` 不属于占位符替换（splat 语义），有直链需求时另提供后缀拼接工具。
 */
export function buildPath(template: string, params: Readonly<Record<string, string>> = {}): string {
  return template.replace(
    /:([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, name: string) => params[name] ?? match
  )
}
