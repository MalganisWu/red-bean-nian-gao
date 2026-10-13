import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type LazyExoticComponent,
  type ReactElement,
} from 'react'

import { TABS, TAB_GROUPS, type TabGroupDefinition, type TabId } from './showcase/tabs'

type PageComponent = () => ReactElement

/** 拉取展示页模块并取出其中的页面组件，供 `React.lazy` 作为加载函数使用。 */
async function loadPageModule<TModule>(
  loadModule: () => Promise<TModule>,
  selectPage: (module: TModule) => PageComponent
): Promise<{ default: PageComponent }> {
  const module = await loadModule()
  return { default: selectPage(module) }
}

function lazyPage<TModule>(
  loadModule: () => Promise<TModule>,
  selectPage: (module: TModule) => PageComponent
): LazyExoticComponent<PageComponent> {
  return lazy(() => loadPageModule(loadModule, selectPage))
}

const PAGES: Record<TabId, LazyExoticComponent<PageComponent>> = {
  philosophy: lazyPage(
    () => import('./foundations/PhilosophyPage'),
    (module) => module.PhilosophyPage
  ),
  color: lazyPage(
    () => import('./foundations/ColorPage'),
    (module) => module.ColorPage
  ),
  typography: lazyPage(
    () => import('./foundations/TypographyPage'),
    (module) => module.TypographyPage
  ),
  conversation: lazyPage(
    () => import('./foundations/ConversationPage'),
    (module) => module.ConversationPage
  ),
  standards: lazyPage(
    () => import('./foundations/StandardsPage'),
    (module) => module.StandardsPage
  ),
  spacing: lazyPage(
    () => import('./foundations/SpacingPage'),
    (module) => module.SpacingPage
  ),
  radius: lazyPage(
    () => import('./foundations/RadiusPage'),
    (module) => module.RadiusPage
  ),
  shadow: lazyPage(
    () => import('./foundations/ShadowPage'),
    (module) => module.ShadowPage
  ),
  button: lazyPage(
    () => import('./showcase/ButtonsActionsPage'),
    (module) => module.ButtonsActionsPage
  ),
  input: lazyPage(
    () => import('./showcase/InputsPage'),
    (module) => module.InputsPage
  ),
  avatar: lazyPage(
    () => import('./showcase/AvatarPage'),
    (module) => module.AvatarPage
  ),
  menu: lazyPage(
    () => import('./showcase/MenuPage'),
    (module) => module.MenuPage
  ),
  tooltip: lazyPage(
    () => import('./showcase/TooltipPage'),
    (module) => module.TooltipPage
  ),
  toast: lazyPage(
    () => import('./showcase/ToastPage'),
    (module) => module.ToastPage
  ),
  'reasoning-block': lazyPage(
    () => import('./showcase/ReasoningBlockPage'),
    (module) => module.ReasoningBlockPage
  ),
  'process-fold': lazyPage(
    () => import('./showcase/ProcessFoldPage'),
    (module) => module.ProcessFoldPage
  ),
  'round-nav': lazyPage(
    () => import('./showcase/RoundNavPage'),
    (module) => module.RoundNavPage
  ),
  'question-card': lazyPage(
    () => import('./showcase/QuestionCardPage'),
    (module) => module.QuestionCardPage
  ),
  'agent-delegation': lazyPage(
    () => import('./showcase/AgentDelegationPage'),
    (module) => module.AgentDelegationPage
  ),
  'scheduled-task': lazyPage(
    () => import('./showcase/ScheduledTaskPage'),
    (module) => module.ScheduledTaskPage
  ),
  trajectory: lazyPage(
    () => import('./showcase/TrajectoryPage'),
    (module) => module.TrajectoryPage
  ),
  markdown: lazyPage(
    () => import('./showcase/MarkdownPage'),
    (module) => module.MarkdownPage
  ),
  brand: lazyPage(
    () => import('./showcase/BrandPage'),
    (module) => module.BrandPage
  ),
}

function PageLoading(): ReactElement {
  return (
    <div className="ds-page-loading" role="status">
      正在加载展示页…
    </div>
  )
}

/** 把主题同步到根元素与本地存储，下次打开时直接恢复。 */
function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
  window.localStorage.setItem('rbng-design-theme', theme)
}

/**
 * 展示站根组件：左侧按分组渲染页签导航，右侧按当前页签懒加载对应展示页。
 * 主题开关只改根元素 class 与本地存储，展示页无需感知主题——它们全部消费语义 token。
 */
export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('philosophy')
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  )
  const ActivePage = PAGES[activeTab]

  useEffect(() => applyTheme(theme), [theme])

  /** 渲染一个侧栏分组；分组下没有页签时不渲染。 */
  function renderNavGroup(group: TabGroupDefinition): ReactElement | null {
    const items = TABS.filter((tab) => tab.group === group.id)
    if (items.length === 0) return null
    return (
      <div key={group.id} className="ds-nav-group">
        <h2 className="ds-nav-group__title">{group.label}</h2>
        <div className="ds-nav-list" role="tablist" aria-label={group.label}>
          {items.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`ds-nav-btn${activeTab === tab.id ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="ds-nav-btn__bullet" aria-hidden="true" />
              <span className="ds-nav-btn__label">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="ds-app">
      <aside className="ds-sidebar" aria-label="主导航">
        <div className="ds-sidebar__brand">
          <h1 className="ds-sidebar__title">red-bean-nian-gao</h1>
          <span className="ds-sidebar__subtitle">设计系统 · Quiet Tool UI</span>
        </div>

        <nav className="ds-nav" aria-label="模块导航">
          {TAB_GROUPS.map(renderNavGroup)}
        </nav>

        <div className="ds-sidebar__theme-toggle">
          <button
            type="button"
            className="ds-theme-button"
            aria-label={theme === 'dark' ? '切换到白天模式' : '切换到暗色模式'}
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <span>{theme === 'dark' ? '切换到白天模式' : '切换到暗色模式'}</span>
            <span className="ds-theme-button__icon" aria-hidden="true">
              {theme === 'dark' ? '☀' : '☾'}
            </span>
          </button>
        </div>
      </aside>

      <main key={activeTab} className="ds-content">
        <Suspense fallback={<PageLoading />}>
          <ActivePage />
        </Suspense>
      </main>
    </div>
  )
}
