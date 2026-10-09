export type TabGroupId = 'foundations' | 'components'

export interface TabGroupDefinition {
  id: TabGroupId
  label: string
}

export interface TabDefinition {
  id: TabId
  label: string
  group: TabGroupId
}

export type TabId =
  | 'philosophy'
  | 'color'
  | 'typography'
  | 'conversation'
  | 'standards'
  | 'spacing'
  | 'radius'
  | 'shadow'
  | 'button'
  | 'input'
  | 'avatar'
  | 'menu'
  | 'tooltip'
  | 'toast'
  | 'reasoning-block'
  | 'process-fold'
  | 'round-nav'
  | 'question-card'
  | 'agent-delegation'
  | 'scheduled-task'
  | 'trajectory'
  | 'markdown'
  | 'brand'

export const TAB_GROUPS: readonly TabGroupDefinition[] = [
  { id: 'foundations', label: '基础 · Foundations' },
  { id: 'components', label: '组件 · Components' },
]

export const TABS: readonly TabDefinition[] = [
  { id: 'philosophy', label: '设计理念 · Philosophy', group: 'foundations' },
  { id: 'color', label: '颜色 · Color', group: 'foundations' },
  { id: 'typography', label: '排版 · Typography', group: 'foundations' },
  { id: 'conversation', label: '对话 · Conversation', group: 'foundations' },
  { id: 'standards', label: '规范 · Standards', group: 'foundations' },
  { id: 'spacing', label: '间距 · Spacing', group: 'foundations' },
  { id: 'radius', label: '圆角 · Radius', group: 'foundations' },
  { id: 'shadow', label: '阴影 · Shadow', group: 'foundations' },
  { id: 'button', label: '按钮 · Button', group: 'components' },
  { id: 'input', label: '输入框 · Input', group: 'components' },
  { id: 'avatar', label: '头像 · Avatar', group: 'components' },
  { id: 'menu', label: '菜单 · Menu', group: 'components' },
  { id: 'tooltip', label: '提示 · Tooltip', group: 'components' },
  { id: 'toast', label: '通知 · Toast', group: 'components' },
  { id: 'reasoning-block', label: '推理块 · ReasoningBlock', group: 'components' },
  { id: 'process-fold', label: '过程折叠 · ProcessFold', group: 'components' },
  { id: 'round-nav', label: '轮次导航 · RoundNav', group: 'components' },
  { id: 'question-card', label: '确认卡 · QuestionCard', group: 'components' },
  { id: 'agent-delegation', label: '子代理委派 · Agent Delegation', group: 'components' },
  { id: 'scheduled-task', label: '定时任务 · Scheduled Tasks', group: 'components' },
  { id: 'trajectory', label: '会话轨迹 · Trajectory', group: 'components' },
  { id: 'markdown', label: 'Markdown 排版 · Markdown', group: 'components' },
  { id: 'brand', label: '品牌 · Brand', group: 'components' },
]
