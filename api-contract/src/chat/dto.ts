/** 聊天请求及 SSE wire DTO；不包含解析、展示或业务逻辑。 */
/** 单条对话消息；`role` 只有 user / assistant，`content` 非空。 */
export interface ChatMessageDto {
  readonly role: 'assistant' | 'user'
  readonly content: string
}

/** 发起对话请求；两个 ID 都可缺省，由服务端补默认值。 */
export interface ChatRequestDto {
  readonly messages: ChatMessageDto[]
  readonly session_id?: string | undefined
  readonly agent_id?: string | undefined
}

/** 取消运行请求；`request_id` 就是发起对话时服务端返回的那个。 */
export interface CancelRequestDto {
  readonly request_id: string
}

/** 单个问题的作答；`value` 对应单选与自定义输入，`values` 对应多选。 */
export interface QuestionAnswerDto {
  readonly kind: 'option' | 'multi' | 'custom' | 'skip'
  readonly value?: string | undefined
  readonly values?: string[] | undefined
}

/** 答题请求；`answers` 与 `refused` 至少要给一个，「没答」不能由两者皆空表达。 */
export interface AnswerRequestDto {
  readonly session_id: string
  readonly interaction_id: string
  readonly agent_id?: string | undefined
  readonly answers?: Readonly<Record<string, QuestionAnswerDto>> | undefined
  readonly refused?: boolean | undefined
}

/** 流已建立的首帧；客户端在此之前不应期待任何事件。 */
export interface StartEventDto {
  readonly request_id: string
  readonly session_id: string
  readonly trace_id: string
}

/** 正文增量帧；多个帧按到达顺序拼接成完整回复。 */
export interface TokenEventDto {
  readonly content: string
}

/** 状态帧；`code` 是机器判据、`content` 是已本地化文案，两者可分别用于分支与展示。 */
export interface StatusEventDto {
  readonly content: string
  readonly code?: string | undefined
  readonly attempt?: number | undefined
  readonly max_attempts?: number | undefined
}

/** 工具开始执行帧；`params` 为 null 表示这次调用的参数不是可解析的 JSON 对象。 */
export interface ToolStartEventDto {
  readonly tool_name: string
  readonly call_id: string
  readonly params: Readonly<Record<string, unknown>> | null
}

/** 工具结果帧；`error` 有值即表示这次调用失败。 */
export interface ToolResultEventDto {
  readonly tool_name: string
  readonly call_id: string
  readonly content: string
  readonly error?: string | undefined
}

/** 正常收尾帧；出现它即表示不会再有后续帧。 */
export interface DoneEventDto {
  readonly tokens_used: number
  readonly session_id: string
}

/** 失败收尾帧；与 `done` 互斥，两者必有其一作为流的收尾。 */
export interface ErrorEventDto {
  readonly code: number
  readonly message: string
}

/** 保活帧；长时间无业务事件时由服务端补齐，防止中间层按空闲超时掐断连接。 */
export interface HeartbeatEventDto {
  readonly timestamp: number
}

/** 推理摘要帧；`step` 是本轮内的工具迭代序号。 */
export interface ReasonEventDto {
  readonly content: string
  readonly step: number
  readonly timestamp: number
}

/** 上下文压缩帧；token 数为估算值，只用于展示压缩量级。 */
export interface CompactionEventDto {
  readonly trigger: 'auto' | 'manual'
  readonly pre_tokens: number
  readonly post_tokens: number
  readonly messages_summarized: number
}

/** 卡片中的单个问题；`options` 与 `select` 成对使用，没有选项时按自由输入处理。 */
export interface QuestionDto {
  readonly id: string
  readonly text: string
  readonly description?: string | undefined
  readonly options?: string[] | undefined
  readonly select?: 'single' | 'multi' | undefined
}

/** 交互卡片帧；`status` 三态与后端的卡片状态一一对应。 */
export interface CardEventDto {
  readonly interaction_id: string
  readonly status: 'pending' | 'answered' | 'refused'
  readonly questions: QuestionDto[]
}

/** 子 Agent 事件信封；`event` 是内层事件的原始载荷，形状由 `event_type` 决定。 */
export interface SubAgentEnvelopeDto {
  readonly agent_id: string
  readonly agent_name: string
  readonly execution_id: string
  readonly parent_call_id: string
  readonly event_type: string
  readonly event: unknown
}
