import type {
  AnswerRequestDto,
  CancelRequestDto,
  CardSectionDataDto,
  ChatMessageDto,
  ChatRequestDto,
  DisplayMessageMetaDto,
  PersistedDisplayMessageDto,
  PersistedMessageSectionDto,
  PersistedSubAgentSectionDataDto,
  PersistedToolCardDto,
  ScheduledTaskMetaDto,
} from '@red-bean/api-contract'

import type { QuestionCardAnswer } from '@/components/retroui/QuestionCard'

// ── 询问卡片（ask-card / human-in-loop）───────────────
// 卡片是消息 sections 里的一个 type="card" section（非独立字段），
// 保证「提问 + 卡片 + 续跑」在一条消息里、卡片位置在中间。

/** 询问卡片的数据载荷；即消息 sections 里 type="card" 段的 `card` 字段。 */
export type CardSectionData = CardSectionDataDto

/** 仅存在于前端运行期；失败时卡片仍保持 pending，允许原地重试。 */
export interface CardSubmissionState {
  interactionId: string
  /** accepted 仅用于 START 后的即时回显；DONE 才写入持久卡片，ERROR 可无损回滚。 */
  state: 'submitting' | 'accepted' | 'error'
  answers?: Record<string, QuestionCardAnswer> | undefined
  refused?: boolean | undefined
  error?: string | undefined
}

// ── Chat Request（来自共享 API 契约）──────────────────

/** 发起一轮对话的请求体；结构由共享契约定义，此处仅作类型别名透传。 */
export type ChatRequest = ChatRequestDto
/** 一条对话消息（用户或助手）；结构等同共享契约的同名 DTO。 */
export type ChatMessage = ChatMessageDto
/** 取消运行的请求体。 */
export type ChatCancelRequest = CancelRequestDto
/** 提交卡片作答的请求体。 */
export type AnswerRequest = AnswerRequestDto

// ── Message Sections（线性渲染分段）───────────────────

/** 思考流中的一步：序号 + 文本；渲染层按 index 顺序拼装 reason section。 */
export interface ReasonStep {
  index: number
  content: string
}

/** 工具卡片；`cancelled` / `incomplete` 是前端派生展示态，后端 SSE 不会发出这两个取值。 */
export interface ToolCard {
  callId: string
  name: string
  label?: string | undefined
  params?: string | undefined
  result?: string | undefined
  error?: string | undefined
  /** cancelled / incomplete 是前端派生展示态，不扩展后端 SSE 契约。 */
  status: 'running' | 'success' | 'failed' | 'cancelled' | 'incomplete'
  duration?: string | undefined
  /** 单工具耗时（毫秒数值）。live 前端按 call_id 计时；历史读持久化 duration。undefined = 未记录 */
  durationMs?: number | undefined
  /** 运行时打点（tool_start 时刻），结算后清除；不进持久化 */
  startedAtMs?: number | undefined
}

/** reason section 里的一项：一段思考步骤，或一次工具调用。 */
export interface ReasonItem {
  itemType: 'step' | 'tool'
  index?: number | undefined
  content?: string | undefined
  tool?: ToolCard | undefined
}

/** 工具卡片的持久化形态；实时流中的卡片用 `ToolCard`，两者字段一致但生命周期不同。 */
export type PersistedToolCard = PersistedToolCardDto

// ── 子 Agent 委派（sub_agent section）─────────────────
// 线格式与后端 SubAgentSectionData 一致（字段 snake_case 透传，session 历史不经过转换层）。
// sections 与主消息同构递归复用；parent_call_id 同时用于实时与历史回放恢复父工具层级。

/** 子 Agent 委派段的载荷；sections 与主消息同构递归，parent_call_id 用于还原父工具层级。 */
export interface SubAgentSectionData {
  agent_id: string
  agent_name: string
  execution_id: string
  sections: MessageSection[]
  /** cancelled / incomplete 仅用于结束后避免历史委派永久显示为运行中。 */
  status?:
    'running' | 'completed' | 'failed' | 'awaiting_user' | 'cancelled' | 'incomplete' | undefined
  result_summary?: string | undefined
  parent_call_id?: string | undefined
}

// ── 思考过程折叠区（process section）─────────────────
// 渲染层收束产物：一轮里除最终 content 外的全部 section 按时间序收束；
// 匹配 parent_call_id 的 sub_agent 嵌入父 tool，未匹配数据保留独立步骤。
// 纯渲染形态，不存在于持久化（spec: process-fold-timeline §2）。

/** 过程折叠区的一步；kind 决定其余字段，属纯渲染形态，不落库。 */
export interface ProcessStepItem {
  kind: 'think' | 'narration' | 'tool' | 'sub_agent' | 'approval'
  /** think / narration 的文本 */
  content?: string | undefined
  tool?: ToolCard | undefined
  /** 独立 sub_agent 步骤，或按 parent_call_id 挂在 tool 步骤上的子委派。 */
  subAgent?: SubAgentSectionData | undefined
  /** approval 步骤：保留原始卡片数据，渲染层转 QuestionCard */
  approval?: CardSectionData | undefined
}

/**
 * 消息的分段联合；`type` 决定其余字段。
 * `process` 是**纯渲染态**：它由前端把一轮里的零散 section 收束而成，只用于折叠展示，不落库。
 */
export type MessageSection =
  | { type: 'reason'; items: ReasonItem[]; timestamp: number; duration?: number | undefined }
  | { type: 'tool_group'; tools: ToolCard[]; timestamp: number; duration?: number | undefined }
  | { type: 'content'; content: string; timestamp: number; duration?: number | undefined }
  | { type: 'card'; card: CardSectionData; timestamp: number }
  | { type: 'sub_agent'; items: SubAgentSectionData; timestamp: number }
  | { type: 'process'; steps: ProcessStepItem[]; timestamp: number }

/** 子 Agent section 的持久化形态（字段 snake_case 透传，不经过转换层）。 */
export type PersistedSubAgentSectionData = PersistedSubAgentSectionDataDto
/** 消息 section 的持久化联合；与 `MessageSection` 的差别是它没有 `process`。 */
export type PersistedMessageSection = PersistedMessageSectionDto

// ── 消息来源 / 元信息（TaskResultCard 用）─────────────

/** 定时任务来源的元信息；用于在结果消息上标注该轮来自哪条调度的运行。 */
export type ScheduledTaskMeta = ScheduledTaskMetaDto
/** 展示元信息：定时任务来源、本轮运行开始时间，或过程块的终止状态。 */
export type DisplayMessageMeta = DisplayMessageMetaDto

// ── 前端展示消息 ────────────────────────────────────

interface DisplayMessagePayload {
  role: 'user' | 'assistant'
  content?: string | undefined
  source?: string | undefined // 消息来源标记（"scheduled_task" = 定时任务结果；空 = 普通对话）
  meta?: DisplayMessageMeta | undefined // 元信息（嵌套包一层）
  timestamp: number
}

/** 后端持久化与 API 传输使用的消息形态，不包含前端运行时标识。 */
export type PersistedDisplayMessage = PersistedDisplayMessageDto

/** 前端列表渲染使用的消息形态；id 只在加载或实时生成时创建。 */
export interface DisplayMessage extends DisplayMessagePayload {
  id: string
  sections?: MessageSection[] | undefined
}
