import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type LazyExoticComponent,
  type ReactElement,
} from 'react'

import { TABS, TAB_GROUPS, type TabGroupDefinition, type TabId } from './showcase/tabs'

/** 展示页组件的统一形态：不接受 props，直接返回一棵 React 元素树。 */
type PageComponent = () => ReactElement

/**
 * 拉取展示页模块并取出其中的页面组件，供 `React.lazy` 作为加载函数使用。
 *
 * 本函数是懒加载失败语义的中转点：动态 import 被拒绝、或模块求值抛错时，它不会吞掉
 * 异常，而是让 Promise 继续拒绝，由 `React.lazy` 在渲染期把错误抛给最近的错误边界。
 *
 * @param loadModule - 动态 import 的加载函数，由调用方闭包住具体页面路径。
 * @param selectPage - 从已加载模块里挑出页面组件的选择器，把模块导出形状与懒加载约定解耦。
 * @returns 形如 `{ default: PageComponent }` 的模块包装，符合 `React.lazy` 对加载函数的约定。
 */
async function loadPageModule<TModule>(
  loadModule: () => Promise<TModule>,
  selectPage: (module: TModule) => PageComponent
): Promise<{ default: PageComponent }> {
  const module = await loadModule()
  return { default: selectPage(module) }
}

/**
 * 把「动态 import + 选择器」组装成 `React.lazy` 组件，供路由表按页签取用。
 *
 * 失败语义与 `loadPageModule` 一致：不降级、不返回备用组件，加载错误一律交给
 * 错误边界处理——静默兜底会让「页面加载失败」伪装成空白页，反而掩盖问题。
 *
 * @param loadModule - 动态 import 的加载函数，闭包住具体页面模块路径。
 * @param selectPage - 从加载到的模块里取出页面组件的选择器。
 * @returns 可交给 React 渲染、并在首次进入时触发懒加载的组件。
 */
function lazyPage<TModule>(
  loadModule: () => Promise<TModule>,
  selectPage: (module: TModule) => PageComponent
): LazyExoticComponent<PageComponent> {
  return lazy(() => loadPageModule(loadModule, selectPage))
}

/**
 * 页签 id 到展示页组件的路由表：每个条目都是一段独立的懒加载分包，
 * 只有切到对应页签才拉取，避免首屏把全部展示页打进主包。
 *
 * 键类型是 `TabId` 而非 `string`，因此新增页签时类型检查会强制补上对应条目，
 * 不会留下「点了没反应」的空档。
 */
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

/**
 * 懒加载期间的占位：以 `role="status"` 把「正在加载」暴露给辅助技术。
 *
 * 只给文字、不做骨架屏——占位与真实页面尺寸不一致时骨架反而制造布局抖动。
 *
 * @returns 承载加载文案的占位元素。
 */
function PageLoading(): ReactElement {
  return (
    <div className="ds-page-loading" role="status">
      正在加载展示页…
    </div>
  )
}

/**
 * 把主题同步到根元素与本地存储，下次打开时直接恢复。
 *
 * 持久化没有兜底：`localStorage` 被禁用或写满时 `setItem` 会抛错并向上冒泡。
 * 这是有意的取舍——本函数只负责同步，加 try/catch 静默吞掉错误会让「主题不生效」
 * 无从排查；本会话内的主题切换仍依赖调用方在 `useEffect` 中触发。
 *
 * @param theme - 目标主题；`dark` 时给根元素加 `dark` 类并同步 `color-scheme`，
 *   `light` 时移除该类，两套主题都通过语义 token 生效。
 */
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

  // 渲染一个侧栏分组；分组下没有页签时不渲染。
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
