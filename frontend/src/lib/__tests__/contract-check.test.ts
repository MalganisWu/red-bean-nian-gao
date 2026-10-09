// 前端 ↔ 共享可执行契约校验（对称于后端 contract test）
// 机器唯一事实来源：@red-bean/api-contract；Markdown 仅作为人类说明的同步投影。
// 覆盖两类漂移：
//   1. 服务层每个 API 调用（path + method）都必须是文档记录的路由
//   2. SSE 事件类型、canonical payload 与运行时守卫必须和文档一致
// 改动后端接口或前端调用路径后，跑 `pnpm test` 应全绿。

/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_ROUTES } from '@red-bean/api-contract'
import {
  isPublicUser,
  isSessionDetail,
  isUser,
  isUserList,
} from '@/services/api/response-validation'
import {
  SSE_EVENT_TYPES,
  isCardEvent,
  isCompactionEvent,
  isDoneEvent,
  isErrorEvent,
  isHeartbeatEvent,
  isReasonEvent,
  isStartEvent,
  isStatusEvent,
  isSubAgentEnvelope,
  isTokenEvent,
  isToolResultEvent,
  isToolStartEvent,
} from '@/types/events'
import type { SSEEventType } from '@/types/events'

// vi.mock 会被提升到 import 之前，须用 vi.hoisted 提供可引用的 mock 函数
const { mockApiCall } = vi.hoisted(() => ({ mockApiCall: vi.fn() }))
vi.mock('@/services/api/client', () => ({ apiCall: mockApiCall }))

import * as authApi from '@/services/api/auth'
import * as chatApi from '@/services/api/chat'
import * as sessionApi from '@/services/api/session'
import * as taskApi from '@/services/api/task'
import * as userApi from '@/services/api/user'

// ── 契约文档解析 ──────────────────────────────────────────────

// vitest 的 cwd 恒为 frontend/，契约文档在仓库根 docs/ 下
const docPath = resolve(process.cwd(), '../docs/contracts/api.md')

function readDoc(): string {
  return readFileSync(docPath, 'utf-8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 归一化：去 query、去尾斜杠、`:xxx`/`*xxx` 段统一为 `:param` */
function normalizePath(p: string): string {
  return p
    .split('?')[0]
    .replace(/\/+$/, '')
    .split('/')
    .map((seg) => (seg.startsWith(':') || seg.startsWith('*') ? ':param' : seg))
    .join('/')
}

/** 解析 ROUTE-TABLE 标记区 → Map<path, Set<method>> */
function parseDocRoutes(): Map<string, Set<string>> {
  const routes = new Map<string, Set<string>>()
  let inTable = false
  for (const line of readDoc().split('\n')) {
    if (line.includes('ROUTE-TABLE-START')) {
      inTable = true
      continue
    }
    if (line.includes('ROUTE-TABLE-END')) {
      inTable = false
      continue
    }
    if (!inTable || !line.startsWith('| ')) continue

    const cols = line.split('|').map((c) => c.trim())
    const method = cols[1]
    const path = cols[2]
    if (!/^(GET|POST|PUT|DELETE|PATCH)$/.test(method) || !path.startsWith('/')) continue
    const methods = routes.get(path)
    if (methods) methods.add(method)
    else routes.set(path, new Set([method]))
  }
  expect(routes.size).toBeGreaterThan(0)
  return routes
}

function sharedRoutes(): Map<string, Set<string>> {
  const routes = new Map<string, Set<string>>()
  for (const route of Object.values(API_ROUTES)) {
    const methods = routes.get(route.path)
    if (methods) methods.add(route.method)
    else routes.set(route.path, new Set([route.method]))
  }
  return routes
}

/** 解析 3.4 节 SSE 事件表 → Set<eventType> */
function parseDocEvents(): Set<string> {
  const doc = readDoc()
  const section = doc.split('### 3.5')[0].split('### 3.4')[1] ?? ''
  const events = new Set<string>()
  for (const line of section.split('\n')) {
    const m = line.match(/^\| `([a-z_]+)` \|/)
    if (m) events.add(m[1])
  }
  expect(events.size).toBeGreaterThan(0)
  return events
}

/** 解析事件表中的必填 payload 字段；带 ? 的字段不计入。 */
function parseDocRequiredEventFields(): Map<string, string[]> {
  const section = readDoc().split('### 3.5')[0].split('### 3.4')[1] ?? ''
  const fields = new Map<string, string[]>()
  for (const line of section.split('\n')) {
    const eventMatch = line.match(/^\| `([a-z_]+)` \|/)
    if (!eventMatch) continue
    const cols = line.split('|').map((c) => c.trim())
    const required = [...(cols[3] ?? '').matchAll(/`([a-z_]+)(\?)?`/g)]
      .filter((match) => match[2] !== '?')
      .map((match) => match[1])
    fields.set(eventMatch[1], required)
  }
  return fields
}

/** 解析前后端共同消费的 SSE-GOLDEN JSON。 */
function parseDocEventGolden(): Record<string, unknown> {
  const doc = readDoc()
  const startMarker = '<!-- SSE-GOLDEN-START -->'
  const endMarker = '<!-- SSE-GOLDEN-END -->'
  const start = doc.indexOf(startMarker)
  const end = doc.indexOf(endMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const block = doc
    .slice(start + startMarker.length, end)
    .trim()
    .replace(/^```json\s*/, '')
    .replace(/\s*```$/, '')
  return JSON.parse(block) as Record<string, unknown>
}

/** 解析前后端共同消费的用户响应 golden。 */
function parseDocUserGolden(): Record<string, unknown> {
  const doc = readDoc()
  const startMarker = '<!-- USER-GOLDEN-START -->'
  const endMarker = '<!-- USER-GOLDEN-END -->'
  const start = doc.indexOf(startMarker)
  const end = doc.indexOf(endMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const block = doc
    .slice(start + startMarker.length, end)
    .trim()
    .replace(/^```json\s*/, '')
    .replace(/\s*```$/, '')
  const parsed: unknown = JSON.parse(block)
  if (!isRecord(parsed)) throw new Error('USER-GOLDEN 必须是 JSON 对象')
  return parsed
}

/** 解析前后端共同消费的会话详情响应 golden。 */
function parseDocSessionDetailGolden(): Record<string, unknown> {
  const doc = readDoc()
  const startMarker = '<!-- SESSION-DETAIL-GOLDEN-START -->'
  const endMarker = '<!-- SESSION-DETAIL-GOLDEN-END -->'
  const start = doc.indexOf(startMarker)
  const end = doc.indexOf(endMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const block = doc
    .slice(start + startMarker.length, end)
    .trim()
    .replace(/^```json\s*/, '')
    .replace(/\s*```$/, '')
  const parsed: unknown = JSON.parse(block)
  if (!isRecord(parsed)) throw new Error('SESSION-DETAIL-GOLDEN 必须是 JSON 对象')
  return parsed
}

const EVENT_GUARDS: Record<SSEEventType, (value: unknown) => boolean> = {
  [SSE_EVENT_TYPES.START]: isStartEvent,
  [SSE_EVENT_TYPES.TOKEN]: isTokenEvent,
  [SSE_EVENT_TYPES.STATUS]: isStatusEvent,
  [SSE_EVENT_TYPES.REASON]: isReasonEvent,
  [SSE_EVENT_TYPES.TOOL_START]: isToolStartEvent,
  [SSE_EVENT_TYPES.TOOL_RESULT]: isToolResultEvent,
  [SSE_EVENT_TYPES.CARD]: isCardEvent,
  [SSE_EVENT_TYPES.DONE]: isDoneEvent,
  [SSE_EVENT_TYPES.HEARTBEAT]: isHeartbeatEvent,
  [SSE_EVENT_TYPES.ERROR]: isErrorEvent,
  [SSE_EVENT_TYPES.COMPACTION]: isCompactionEvent,
  [SSE_EVENT_TYPES.AGENT_EVENT]: isSubAgentEnvelope,
}

/**
 * 返回覆盖 frontendPath 的文档路由。
 * - allowPrefix=false（服务层叫站点）：只认精确匹配，防止删掉的基路由被 :id 子路由掩盖
 * - allowPrefix=true（constants.ts）：额外允许基路径前缀匹配（如 storage 基础常量指向 /:key 路由）
 */
function coveringRoute(
  frontendPath: string,
  routes: Map<string, Set<string>>,
  allowPrefix = true
): string | undefined {
  const f = normalizePath(frontendPath)
  const exact = [...routes.keys()].find((d) => normalizePath(d) === f)
  if (exact) return exact
  if (!allowPrefix) return undefined
  return [...routes.keys()].find((d) => normalizePath(d).startsWith(f + '/'))
}

// ── 测试 ──────────────────────────────────────────────────────

describe('前端 API 契约校验（@red-bean/api-contract）', () => {
  let routes: Map<string, Set<string>>

  beforeEach(() => {
    routes = sharedRoutes()
    mockApiCall.mockReset()
    // 服务函数会解构 apiCall 返回值（data.data），给一个可解析的桩
    mockApiCall.mockResolvedValue({ code: 200, data: {} })
  })

  it('服务层每个 API 调用的 path + method 都在契约文档中', async () => {
    // 显式列出服务层调用点：新增/改路径时同步维护此表 + 契约文档
    const callSites: Array<[string, () => Promise<unknown>]> = [
      ['GET', () => sessionApi.fetchSessions()],
      ['GET', () => sessionApi.fetchSession(':id')],
      ['GET', () => taskApi.fetchSessionTasks(':id')],
      ['GET', () => taskApi.fetchTasks()],
      ['GET', () => taskApi.fetchTask(':id')],
      ['PUT', () => taskApi.updateTask(':id', true)],
      ['DELETE', () => taskApi.deleteTask(':id')],
      ['GET', () => taskApi.fetchExecutions(':id')],
      ['GET', () => taskApi.fetchExecution(':id', ':eid')],
      ['GET', () => taskApi.fetchExecutionViewStates([':eid'])],
      ['PUT', () => taskApi.updateExecutionViewState(':id', ':eid', { mark_seen: true })],
      ['GET', () => userApi.getMe()],
      ['PUT', () => userApi.updateMe({})],
      ['GET', () => userApi.getUser(':id')],
      ['GET', () => userApi.listUsers()],
      ['POST', () => authApi.login({ username: 'u', password: 'p' })],
      [
        'POST',
        () => authApi.register({ username: 'u', email: 'e', password: 'p', display_name: 'u' }),
      ],
      ['POST', () => authApi.refresh('token')],
      ['POST', () => authApi.logout()],
      ['POST', () => chatApi.cancelChat({ request_id: 'req' })],
    ]

    for (const [method, invoke] of callSites) {
      mockApiCall.mockClear()
      await invoke()
      expect(mockApiCall).toHaveBeenCalledTimes(1)

      const calledPath = mockApiCall.mock.calls[0][0] as string
      const covered = coveringRoute(calledPath, routes, /* allowPrefix */ false)
      expect(covered, `${method} ${calledPath} 不在共享契约路由表中`).toBeDefined()
      if (covered) {
        const methods = routes.get(covered)
        if (!methods) throw new Error(`文档路由缺少方法集合：${covered}`)
        expect(
          methods.has(method),
          `${method} ${calledPath} → 共享路由 ${covered} 不支持该方法`
        ).toBe(true)
      }
    }
  })

  it('人类可读文档的路由表是共享契约的完整投影', () => {
    const documented = parseDocRoutes()
    // 与后端契约测试一致：按路径排序后比较，不依赖表的插入顺序
    const normalize = (routes: Map<string, Set<string>>): Array<[string, string[]]> =>
      [...routes.entries()]
        .map(([path, methods]): [string, string[]] => [path, [...methods].sort()])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    expect(normalize(documented)).toEqual(normalize(routes))
  })

  it('人类可读文档的 SSE 事件集合与共享契约完全一致', () => {
    const docEvents = parseDocEvents()
    const frontendEvents = Object.values(SSE_EVENT_TYPES)
    expect([...docEvents].sort()).toEqual([...frontendEvents].sort())
  })

  it('人类可读文档的 SSE 示例通过共享运行时守卫', () => {
    const golden = parseDocEventGolden()
    const eventTypes = Object.values(SSE_EVENT_TYPES)
    expect(Object.keys(golden).sort()).toEqual([...eventTypes].sort())

    for (const eventType of eventTypes) {
      expect(
        EVENT_GUARDS[eventType](golden[eventType]),
        `${eventType} golden 未通过运行时守卫`
      ).toBe(true)
    }
  })

  it('文档用户响应 golden 通过对应的前端运行时守卫', () => {
    const golden = parseDocUserGolden()
    expect(isUser(golden['self_user'])).toBe(true)
    expect(isPublicUser(golden['public_user'])).toBe(true)
    expect(isUserList(golden['user_list'])).toBe(true)
  })

  it('文档会话详情 golden 通过前端运行时守卫', () => {
    expect(isSessionDetail(parseDocSessionDetailGolden())).toBe(true)
  })

  it('共享运行时守卫拒绝缺少文档所展示必填字段的 payload', () => {
    const golden = parseDocEventGolden()
    const requiredFields = parseDocRequiredEventFields()

    for (const eventType of Object.values(SSE_EVENT_TYPES)) {
      const sample = golden[eventType]
      expect(sample && typeof sample === 'object' && !Array.isArray(sample)).toBe(true)
      for (const field of requiredFields.get(eventType) ?? []) {
        const malformed = { ...(sample as Record<string, unknown>) }
        delete malformed[field]
        expect(
          EVENT_GUARDS[eventType](malformed),
          `${eventType} 缺少必填字段 ${field} 时仍通过运行时守卫`
        ).toBe(false)
      }
    }
  })
})
