import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SessionSidebar } from '../SessionSidebar'
import type { ReactElement, ReactNode } from 'react'
import type { SessionSummary } from '@/services/api/session'

const newSession = vi.fn()
const switchSession = vi.fn<(sessionId: string) => Promise<void>>()
const loadSessions = vi.fn<() => Promise<void>>()
const loadMoreSessions = vi.fn<() => Promise<void>>()

interface MockChatStoreState {
  sessions: SessionSummary[]
  sessionsLoading: boolean
  sessionsError: string | null
  activeSessionId: string | null
  nextCursor: string
  loadSessions: () => Promise<void>
  loadMoreSessions: () => Promise<void>
  switchSession: (sessionId: string) => Promise<void>
  newSession: () => void
}

let storeState: MockChatStoreState
vi.mock('@/stores/chat-store', () => ({
  useChatStore: <TResult,>(selector: (state: MockChatStoreState) => TResult): TResult =>
    selector(storeState),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { username: 'redbean', display_name: '豆豆' },
    logout: vi.fn(),
  }),
}))

// Base UI Menu 依赖真实布局测量，jsdom 中渲染会崩；侧栏测试只关心触发层内容
vi.mock('@/components/retroui/Menu', () => {
  const renderChildren = ({ children }: { children?: ReactNode }): ReactElement => <>{children}</>
  const Menu = Object.assign(renderChildren, {
    Trigger: renderChildren,
    Content: renderChildren,
    Item: renderChildren,
    Separator: (): ReactElement => <hr />,
  })
  return { Menu }
})
vi.mock('@/components/retroui/Avatar', () => {
  const Avatar = Object.assign(
    ({ children }: { children?: ReactNode }): ReactElement => <span>{children}</span>,
    {
      Fallback: ({ children }: { children?: ReactNode }): ReactElement => <>{children}</>,
    }
  )
  return { Avatar }
})

function renderSidebar(onNavigate?: () => void) {
  return render(
    <MemoryRouter>
      <SessionSidebar onNavigate={onNavigate} />
    </MemoryRouter>
  )
}

describe('SessionSidebar Quiet Tool 会话侧栏', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadSessions.mockResolvedValue(undefined)
    loadMoreSessions.mockResolvedValue(undefined)
    switchSession.mockResolvedValue(undefined)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'))
    storeState = {
      sessions: [
        {
          id: 's1',
          title: '每天早上帮我搜集 AI 新闻',
          message_count: 23,
          updated_at: '2026-08-28T09:12:00Z',
        },
        {
          id: 's2',
          title: '',
          message_count: 2,
          updated_at: '2026-08-25T22:41:00Z',
        },
        {
          id: 's3',
          title: '工具调用状态',
          message_count: 8,
          updated_at: '2026-08-08T10:00:00Z',
        },
      ],
      sessionsLoading: false,
      sessionsError: null,
      activeSessionId: 's1',
      nextCursor: '',
      loadSessions,
      loadMoreSessions,
      switchSession,
      newSession,
    }
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('品牌字标 + 新建会话 + 定时任务入口 + 时间分组', () => {
    renderSidebar()
    expect(screen.getByLabelText('red bean')).toBeInTheDocument()
    expect(screen.getByText('新建会话')).toBeInTheDocument()
    expect(screen.getByText('定时任务')).toBeInTheDocument()
    expect(screen.getByText('今天')).toBeInTheDocument()
    expect(screen.getByText('最近 7 天')).toBeInTheDocument()
    expect(screen.getByText('更早')).toBeInTheDocument()
  })

  it('会话条目不显示编号与重复 meta；空题名回退「新会话」', () => {
    renderSidebar()
    expect(screen.queryByText('01')).not.toBeInTheDocument()
    expect(screen.queryByText('02')).not.toBeInTheDocument()
    expect(screen.getByText('每天早上帮我搜集 AI 新闻')).toBeInTheDocument()
    expect(screen.getByText('新会话')).toBeInTheDocument()
    expect(screen.queryByText(/^23 条 · /)).not.toBeInTheDocument()
  })

  it('当前会话 = muted 底色 + 豆沙短标，其余保持透明', () => {
    renderSidebar()
    const active = screen.getByText('每天早上帮我搜集 AI 新闻').closest('button')
    const idle = screen.getByText('新会话').closest('button')
    if (!active || !idle) throw new Error('会话按钮未渲染')
    expect(active.className).toContain('bg-muted')
    expect(active.className).toContain('before:bg-brand-indicator')
    expect(idle.className).not.toContain('bg-muted')
  })

  it('点击新建会话 / 切换会话；点当前会话仅关闭移动抽屉', () => {
    const onNavigate = vi.fn()
    renderSidebar(onNavigate)
    fireEvent.click(screen.getByText('新建会话'))
    expect(newSession).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('新会话'))
    expect(switchSession).toHaveBeenCalledWith('s2')
    expect(onNavigate).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByText('每天早上帮我搜集 AI 新闻'))
    expect(switchSession).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledTimes(3)
  })

  it('栏底账户行显示名称与用户名', () => {
    renderSidebar()
    expect(screen.getAllByText('豆豆')).toHaveLength(2)
    expect(screen.getAllByText('redbean')).toHaveLength(3)
  })

  it('错误横幅：鲜红左竖线警示 + 重试', () => {
    storeState.sessionsError = '加载失败'
    renderSidebar()
    expect(screen.getByText('加载失败')).toBeInTheDocument()
    fireEvent.click(screen.getByText('重试'))
    expect(loadSessions).toHaveBeenCalled()
  })
})
