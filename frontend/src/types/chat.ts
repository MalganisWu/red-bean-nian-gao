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
  /** 本次提交对应的卡片交互 id，用于定位要落定的那张卡片。 */
  interactionId: string
  /** accepted 仅用于 START 后的即时回显；DONE 才写入持久卡片，ERROR 可无损回滚。 */
  state: 'submitting' | 'accepted' | 'error'
  /** 用户提交的答案（按题目 id 索引）；拒绝提交时缺省。 */
  answers?: Record<string, QuestionCardAnswer> | undefined
  /** 是否为拒绝提交；为 true 时卡片落定为 refused 而非 answered。 */
  refused?: boolean | undefined
  /** 提交失败时的错误消息；仅 error 态下存在。 */
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
  /** 步骤序号；渲染层据此排序拼装 reason section。 */
  index: number
  /** 该步的思考文本。 */
  content: string
}

/** 工具卡片；`cancelled` / `incomplete` 是前端派生展示态，后端 SSE 不会发出这两个取值。 */
export interface ToolCard {
  /** 工具调用 id；用于把 start 与 result 事件配对到同一张卡片。 */
  callId: string
  /** 工具的内部名（如 shell / read_file），用于展示与对齐。 */
  name: string
  /** 工具对人类可读的展示名；缺省时回落到 name。 */
  label?: string | undefined
  /** 工具入参（已序列化为字符串）；无参数时缺省。 */
  params?: string | undefined
  /** 工具成功返回的结果文本；失败时缺省。 */
  result?: string | undefined
  /** 工具失败时的错误文本；成功时缺省。 */
  error?: string | undefined
  /** cancelled / incomplete 是前端派生展示态，不扩展后端 SSE 契约。 */
  status: 'running' | 'success' | 'failed' | 'cancelled' | 'incomplete'
  /** 工具耗时的展示文本（如 "1.2s"）；历史回放从持久化读取，未记录时缺省。 */
  duration?: string | undefined
  /** 单工具耗时（毫秒数值）。live 前端按 call_id 计时；历史读持久化 duration。undefined = 未记录 */
  durationMs?: number | undefined
  /** 运行时打点（tool_start 时刻），结算后清除；不进持久化 */
  startedAtMs?: number | undefined
}

/** reason section 里的一项：一段思考步骤，或一次工具调用。 */
export interface ReasonItem {
  /** 本项的形态：step 为一段思考，tool 为一次工具调用。 */
  itemType: 'step' | 'tool'
  /** 思考步骤的序号；itemType 为 step 时使用。 */
  index?: number | undefined
  /** 思考步骤的文本；itemType 为 step 时使用。 */
  content?: string | undefined
  /** 工具卡片；itemType 为 tool 时使用。 */
  tool?: ToolCard | undefined
}

/** 工具卡片的持久化形态；实时流中的卡片用 `ToolCard`，两者字段一致但生命周期不同。 */
export type PersistedToolCard = PersistedToolCardDto

// ── 子 Agent 委派（sub_agent section）─────────────────
// 线格式与后端 SubAgentSectionData 一致（字段 snake_case 透传，session 历史不经过转换层）。
// sections 与主消息同构递归复用；parent_call_id 同时用于实时与历史回放恢复父工具层级。

/** 子 Agent 委派段的载荷；sections 与主消息同构递归，parent_call_id 用于还原父工具层级。 */
export interface SubAgentSectionData {
  /** 子 Agent 的标识。 */
  agent_id: string
  /** 子 Agent 的展示名。 */
  agent_name: string
  /** 本次委派执行 id；用于与后端执行记录对齐。 */
  execution_id: string
  /** 子 Agent 内部的分段列表，与主消息同构递归。 */
  sections: MessageSection[]
  /** cancelled / incomplete 仅用于结束后避免历史委派永久显示为运行中。 */
  status?:
    'running' | 'completed' | 'failed' | 'awaiting_user' | 'cancelled' | 'incomplete' | undefined
  /** 委派结束后的结果摘要；运行中缺省。 */
  result_summary?: string | undefined
  /** 触发本次委派的父工具调用 id，用于在渲染层还原父工具层级。 */
  parent_call_id?: string | undefined
}

// ── 思考过程折叠区（process section）─────────────────
// 渲染层收束产物：一轮里除最终 content 外的全部 section 按时间序收束；
// 匹配 parent_call_id 的 sub_agent 嵌入父 tool，未匹配数据保留独立步骤。
// 纯渲染形态，不存在于持久化（spec: process-fold-timeline §2）。

/** 过程折叠区的一步；kind 决定其余字段，属纯渲染形态，不落库。 */
export interface ProcessStepItem {
  /** 步骤种类，决定其余字段中哪一个生效。 */
  kind: 'think' | 'narration' | 'tool' | 'sub_agent' | 'approval'
  /** think / narration 的文本 */
  content?: string | undefined
  /** 工具步骤的工具卡片（kind 为 tool 时使用）。 */
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

/** 前端展示消息的公共载荷；`DisplayMessage` 在其上补 id 与 sections。 */
interface DisplayMessagePayload {
  /** 消息角色；用户或助手。 */
  role: 'user' | 'assistant'
  /** 助手消息的纯文本内容；结构化消息（仅有 sections）时缺省。 */
  content?: string | undefined
  /** 消息来源标记；"scheduled_task" = 定时任务结果，空 = 普通对话。 */
  source?: string | undefined // 消息来源标记（"scheduled_task" = 定时任务结果；空 = 普通对话）
  /** 元信息（嵌套包一层）；无附加元信息时缺省。 */
  meta?: DisplayMessageMeta | undefined // 元信息（嵌套包一层）
  /** 消息时间戳（epoch 毫秒）。 */
  timestamp: number
}

/** 后端持久化与 API 传输使用的消息形态，不包含前端运行时标识。 */
export type PersistedDisplayMessage = PersistedDisplayMessageDto

/** 前端列表渲染使用的消息形态；id 只在加载或实时生成时创建。 */
export interface DisplayMessage extends DisplayMessagePayload {
  /** 前端运行时消息 id；仅加载或实时生成时创建，不来自后端。 */
  id: string
  /** 结构化分段；仅有纯文本 content 的消息缺省。 */
  sections?: MessageSection[] | undefined
}
