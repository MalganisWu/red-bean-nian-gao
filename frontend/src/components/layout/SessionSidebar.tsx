import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarClock, ChevronUp, LogOut, Plus, User } from 'lucide-react'

import { Avatar } from '@/components/retroui/Avatar'
import { BrandMark } from '@/components/retroui/BrandMark'
import { Menu } from '@/components/retroui/Menu'
import { useAuth } from '@/hooks/useAuth'
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll'
import { ROUTES } from '@/lib/constants'
import { formatShortDateTime } from '@/lib/datetime'
import { cn } from '@/lib/utils'
import type { SessionSummary } from '@/services/api/session'
import { useChatStore } from '@/stores/chat-store'

interface SessionSidebarProps {
  onNavigate?: () => void
}

interface SessionGroup {
  label: '今天' | '最近 7 天' | '更早'
  sessions: SessionSummary[]
}

const DAY_IN_MS = 24 * 60 * 60 * 1000

function groupSessionsByUpdatedAt(sessions: SessionSummary[], now = new Date()): SessionGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const today: SessionGroup = { label: '今天', sessions: [] }
  const recent: SessionGroup = { label: '最近 7 天', sessions: [] }
  const older: SessionGroup = { label: '更早', sessions: [] }
  const groups: SessionGroup[] = [today, recent, older]

  /** 把单个会话按 updated_at 落入今天 / 最近 7 天 / 更早分组；时间无法解析时归入更早。 */
  function addSessionToGroup(session: SessionSummary): void {
    const updatedAt = new Date(session.updated_at)
    if (Number.isNaN(updatedAt.getTime())) {
      older.sessions.push(session)
      return
    }

    const startOfUpdatedAt = new Date(
      updatedAt.getFullYear(),
      updatedAt.getMonth(),
      updatedAt.getDate()
    ).getTime()
    const daysAgo = Math.floor((startOfToday - startOfUpdatedAt) / DAY_IN_MS)

    if (daysAgo <= 0) today.sessions.push(session)
    else if (daysAgo < 7) recent.sessions.push(session)
    else older.sessions.push(session)
  }

  sessions.forEach(addSessionToGroup)

  return groups.filter((group) => group.sessions.length > 0)
}

/**
 * Quiet Tool 会话侧栏：单行历史、时间分组和完整账户身份。
 *
 * @param props - 组件属性；字段语义见 `SessionSidebarProps`。
 * @returns 侧栏元素。
 */
export function SessionSidebar(props: SessionSidebarProps): React.ReactElement {
  const { onNavigate } = props
  const sessions = useChatStore((state) => state.sessions)
  const sessionsLoading = useChatStore((state) => state.sessionsLoading)
  const sessionsError = useChatStore((state) => state.sessionsError)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const nextCursor = useChatStore((state) => state.nextCursor)
  const loadSessions = useChatStore((state) => state.loadSessions)
  const loadMoreSessions = useChatStore((state) => state.loadMoreSessions)
  const switchSession = useChatStore((state) => state.switchSession)
  const newSession = useChatStore((state) => state.newSession)

  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const sessionGroups = groupSessionsByUpdatedAt(sessions)
  const { listRef, handleScroll } = useInfiniteScroll(
    () => void loadMoreSessions(),
    Boolean(nextCursor),
    sessionsLoading
  )

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  function handleSelectSession(sessionId: string): void {
    if (sessionId === activeSessionId) {
      onNavigate?.()
      return
    }
    void switchSession(sessionId)
    onNavigate?.()
  }

  function handleNewSession(): void {
    newSession()
    onNavigate?.()
  }

  function handleOpenTasks(): void {
    void navigate(ROUTES.TASKS)
    onNavigate?.()
  }

  async function handleLogout(): Promise<void> {
    await logout()
    void navigate(ROUTES.LOGIN)
  }

  /** 渲染单条历史会话：标题、绝对时间，以及当前会话的高亮态。 */
  function renderSessionItem(session: SessionSummary): React.ReactElement {
    const active = session.id === activeSessionId
    const title = session.title || '新会话'
    return (
      <button
        key={session.id}
        type="button"
        aria-current={active ? 'page' : undefined}
        title={`${title} · ${formatShortDateTime(session.updated_at)}`}
        onClick={() => handleSelectSession(session.id)}
        className={cn(
          'relative flex min-h-11 w-full cursor-pointer items-center rounded-sm border-0 bg-transparent px-2.5 text-left font-sans text-[13px] transition-colors sm:min-h-9',
          active
            ? 'bg-muted font-medium text-foreground before:absolute before:bottom-2.5 before:left-0 before:top-2.5 before:w-0.5 before:rounded-sm before:bg-brand-indicator'
            : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground'
        )}
      >
        <span className="block min-w-0 flex-1 truncate">{title}</span>
      </button>
    )
  }

  const displayName = user?.display_name || user?.username || '用户'
  const accountName = user?.username || user?.email || ''
  const avatarLabel = displayName[0] || 'U'

  return (
    <aside className="flex h-full w-56 flex-col border-r border-border bg-sidebar">
      <div className="px-3 pb-3 pt-4">
        <div className="flex min-h-[30px] items-center px-2">
          <p
            aria-label="red bean"
            className="flex items-center font-sans text-sm font-semibold tracking-[-0.02em] text-foreground"
          >
            red
            <BrandMark size={10} />
            bean
          </p>
        </div>

        <button
          type="button"
          onClick={handleNewSession}
          className="mt-4 flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg border border-border-strong bg-background px-2.5 text-left font-sans text-[13px] font-medium text-foreground-body transition-colors hover:border-foreground-faint hover:text-foreground sm:min-h-[38px]"
        >
          <Plus aria-hidden="true" className="h-4 w-4 text-foreground-muted" strokeWidth={1.7} />
          新建会话
        </button>

        <nav className="mt-3 border-b border-border pb-3" aria-label="功能导航">
          <button
            type="button"
            onClick={handleOpenTasks}
            className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 text-left font-sans text-[13px] text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:min-h-9"
          >
            <CalendarClock aria-hidden="true" className="h-4 w-4" strokeWidth={1.7} />
            定时任务
          </button>
        </nav>
      </div>

      <div
        ref={listRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4"
      >
        {sessionsError && (
          <div role="alert" className="mx-2 mt-3 border-l-2 border-danger py-1 pl-3">
            <p className="text-xs leading-relaxed text-foreground-body">{sessionsError}</p>
            <button
              type="button"
              onClick={() => void loadSessions()}
              className="mt-1 min-h-11 cursor-pointer border-0 bg-transparent p-0 text-xs text-danger hover:underline hover:underline-offset-4 sm:min-h-0"
            >
              重试
            </button>
          </div>
        )}

        {sessionsLoading && sessions.length === 0 && (
          <div role="status" aria-label="会话加载中" className="px-2 py-4">
            <span className="sr-only">会话加载中</span>
            <span className="my-2 block h-2.5 w-3/4 rounded-sm bg-border" />
            <span className="my-2 block h-2.5 w-1/2 rounded-sm bg-border" />
            <span className="my-2 block h-2.5 w-5/6 rounded-sm bg-border" />
          </div>
        )}

        {sessions.length === 0 && !sessionsLoading && !sessionsError && (
          <p className="px-2 py-5 font-sans text-[13px] leading-relaxed text-foreground-muted">
            还没有历史会话。
            <br />
            从上方新建一段对话。
          </p>
        )}

        {sessionGroups.map((group) => (
          <section key={group.label} className="mt-3.5">
            <h2 className="mx-2 mb-1.5 font-sans text-xs font-medium text-foreground-faint">
              {group.label}
            </h2>
            {group.sessions.map(renderSessionItem)}
          </section>
        ))}

        {sessionsLoading && sessions.length > 0 && (
          <p role="status" className="py-3 text-center text-xs text-foreground-faint">
            加载更多…
          </p>
        )}
      </div>

      <div className="relative shrink-0 px-2.5 pb-[max(10px,env(safe-area-inset-bottom))] before:mx-1 before:mb-2 before:block before:h-px before:bg-border">
        <Menu>
          <Menu.Trigger className="group grid min-h-[52px] w-full cursor-pointer grid-cols-[24px_minmax(0,1fr)_16px] items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-foreground transition-colors hover:bg-surface-hover data-[popup-open]:bg-surface-hover">
            <Avatar className="h-6 w-6">
              <Avatar.Fallback className="text-[10px]">{avatarLabel}</Avatar.Fallback>
            </Avatar>
            <span className="min-w-0">
              <strong className="block truncate font-sans text-[13px] font-semibold leading-snug text-foreground">
                {displayName}
              </strong>
              <span className="mt-0.5 block truncate font-sans text-xs leading-tight text-foreground-faint">
                {accountName}
              </span>
            </span>
            <ChevronUp
              aria-hidden="true"
              className="h-3.5 w-3.5 text-foreground-faint transition-transform group-data-[popup-open]:rotate-180"
              strokeWidth={1.7}
            />
          </Menu.Trigger>
          <Menu.Content className="w-[198px]">
            <div className="px-2.5 pb-2 pt-1.5">
              <strong className="block truncate font-sans text-[13px] font-semibold text-foreground">
                {displayName}
              </strong>
              <span className="mt-0.5 block truncate font-sans text-xs text-foreground-faint">
                {user?.email || accountName}
              </span>
            </div>
            <Menu.Separator />
            <Menu.Item onClick={() => void navigate(ROUTES.PROFILE)}>
              <User
                aria-hidden="true"
                className="h-4 w-4 text-foreground-muted"
                strokeWidth={1.7}
              />
              个人信息
            </Menu.Item>
            <Menu.Item
              className="hover:text-danger focus:text-danger"
              onClick={() => void handleLogout()}
            >
              <LogOut aria-hidden="true" className="h-4 w-4" strokeWidth={1.7} />
              退出登录
            </Menu.Item>
          </Menu.Content>
        </Menu>
      </div>
    </aside>
  )
}
