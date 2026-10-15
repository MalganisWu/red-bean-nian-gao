// 聊天请求及 SSE wire DTO；不包含解析、展示或业务逻辑。

/** 单条对话消息；`role` 只有 user / assistant，`content` 非空。 */
export interface ChatMessageDto {
  /** 消息角色；只有 user 与 assistant 两个取值，服务端不会返回其它角色。 */
  readonly role: 'assistant' | 'user'
  /** 消息正文，非空；空消息在契约层即被拒。 */
  readonly content: string
}

/** 发起对话请求；两个 ID 都可缺省，由服务端补默认值。 */
export interface ChatRequestDto {
  /** 本轮提交的消息列表，至少一条；数组顺序即对话顺序。 */
  readonly messages: ChatMessageDto[]
  /** 会话 ID；缺省时由服务端新建会话并回填，给了则必须是已存在的会话。 */
  readonly session_id?: string | undefined
  /** 目标 Agent ID；缺省时由服务端取默认 Agent。 */
  readonly agent_id?: string | undefined
}

/** 取消运行请求；`request_id` 就是发起对话时服务端返回的那个。 */
export interface CancelRequestDto {
  /** 要取消的运行 ID，取自 `start` 帧；不存在的 ID 由服务端按幂等处理。 */
  readonly request_id: string
}

/** 单个问题的作答；`value` 对应单选与自定义输入，`values` 对应多选。 */
export interface QuestionAnswerDto {
  /** 作答类型；决定 `value` 与 `values` 哪个有效，skip 表示显式跳过该问题。 */
  readonly kind: 'option' | 'multi' | 'custom' | 'skip'
  /** 单选取值或自定义输入文本；多选与跳过时缺省。 */
  readonly value?: string | undefined
  /** 多选取值数组；仅在 `kind` 为 multi 时使用。 */
  readonly values?: string[] | undefined
}

/** 答题请求；`answers` 与 `refused` 至少要给一个，「没答」不能由两者皆空表达。 */
export interface AnswerRequestDto {
  /** 会话 ID，必须是发起本次交互的那个会话。 */
  readonly session_id: string
  /** 交互 ID，取自 card 帧；用来把作答绑定到具体卡片。 */
  readonly interaction_id: string
  /** 目标 Agent ID；缺省时由服务端取默认 Agent。 */
  readonly agent_id?: string | undefined
  /** 按问题 ID 索引的作答表；与 `refused` 至少给一个。 */
  readonly answers?: Readonly<Record<string, QuestionAnswerDto>> | undefined
  /** 是否拒绝作答；true 表示用户明确拒答，与「未作答」语义不同。 */
  readonly refused?: boolean | undefined
}

/** 流已建立的首帧；客户端在此之前不应期待任何事件。 */
export interface StartEventDto {
  /** 本次运行的请求 ID；取消与重连都以它为准。 */
  readonly request_id: string
  /** 会话 ID；后续帧与请求都引用同一个会话。 */
  readonly session_id: string
  /** 链路追踪 ID，与响应头 `x-trace-id` 一致。 */
  readonly trace_id: string
}

/** 正文增量帧；多个帧按到达顺序拼接成完整回复。 */
export interface TokenEventDto {
  /** 正文增量片段；需按到达顺序拼接，单帧不保证是完整句子。 */
  readonly content: string
}

/** 状态帧；`code` 是机器判据、`content` 是已本地化文案，两者可分别用于分支与展示。 */
export interface StatusEventDto {
  /** 已本地化的展示文案；直接呈现给用户。 */
  readonly content: string
  /** 机器判据码；用于前端分支，与 `content` 的文案解耦。 */
  readonly code?: string | undefined
  /** 当前尝试序号，从 1 开始。 */
  readonly attempt?: number | undefined
  /** 本次重试的最大尝试次数。 */
  readonly max_attempts?: number | undefined
}

/** 工具开始执行帧；`params` 为 null 表示这次调用的参数不是可解析的 JSON 对象。 */
export interface ToolStartEventDto {
  /** 工具名，与注册的 `sys_*` 工具标识一致。 */
  readonly tool_name: string
  /** 本次工具调用的 ID；与 `tool_result` 帧按同值配对。 */
  readonly call_id: string
  /** 工具入参的 JSON 对象；为 null 表示入参不是可解析的 JSON 对象。 */
  readonly params: Readonly<Record<string, unknown>> | null
}

/** 工具结果帧；`error` 有值即表示这次调用失败。 */
export interface ToolResultEventDto {
  /** 工具名，与 `tool_start` 帧一致。 */
  readonly tool_name: string
  /** 本次工具调用的 ID，与 `tool_start` 帧配对。 */
  readonly call_id: string
  /** 工具返回的正文；失败的调用也可能是空串。 */
  readonly content: string
  /** 失败原因；有值即表示这次调用失败，成功时缺省。 */
  readonly error?: string | undefined
}

/** 正常收尾帧；出现它即表示不会再有后续帧。 */
export interface DoneEventDto {
  /** 本次运行的 token 用量估算值。 */
  readonly tokens_used: number
  /** 会话 ID；用于客户端刷新会话列表。 */
  readonly session_id: string
}

/** 失败收尾帧；与 `done` 互斥，两者必有其一作为流的收尾。 */
export interface ErrorEventDto {
  /** 业务错误码，取值来自 `API_ERROR_CODES`。 */
  readonly code: number
  /** 已本地化的错误文案，可直接展示。 */
  readonly message: string
}

/** 保活帧；长时间无业务事件时由服务端补齐，防止中间层按空闲超时掐断连接。 */
export interface HeartbeatEventDto {
  /** 保活帧的发送时刻，epoch 毫秒。 */
  readonly timestamp: number
}

/** 推理摘要帧；`step` 是本轮内的工具迭代序号。 */
export interface ReasonEventDto {
  /** 本条推理摘要文本。 */
  readonly content: string
  /** 本轮内的工具迭代序号，从 1 开始。 */
  readonly step: number
  /** 该帧产生的时刻，epoch 毫秒。 */
  readonly timestamp: number
}

/** 上下文压缩帧；token 数为估算值，只用于展示压缩量级。 */
export interface CompactionEventDto {
  /** 压缩触发方式：auto 由系统按阈值触发，manual 由用户操作触发。 */
  readonly trigger: 'auto' | 'manual'
  /** 压缩前的上下文 token 估算值。 */
  readonly pre_tokens: number
  /** 压缩后的上下文 token 估算值。 */
  readonly post_tokens: number
  /** 被总结折叠掉的消息条数。 */
  readonly messages_summarized: number
}

/** 卡片中的单个问题；`options` 与 `select` 成对使用，没有选项时按自由输入处理。 */
export interface QuestionDto {
  /** 问题 ID；作答表以它为键。 */
  readonly id: string
  /** 问题正文，展示给用户。 */
  readonly text: string
  /** 补充说明；缺省表示没有额外描述。 */
  readonly description?: string | undefined
  /** 选项列表；缺省或为空表示按自由输入处理。 */
  readonly options?: string[] | undefined
  /** 选择方式；single 单选、multi 多选，缺省表示自由输入。 */
  readonly select?: 'single' | 'multi' | undefined
}

/** 交互卡片帧；`status` 三态与后端的卡片状态一一对应。 */
export interface CardEventDto {
  /** 交互 ID；作答请求以它绑定到这张卡片。 */
  readonly interaction_id: string
  /** 卡片三态：pending 待作答、answered 已作答、refused 已拒答。 */
  readonly status: 'pending' | 'answered' | 'refused'
  /** 卡片包含的问题列表。 */
  readonly questions: QuestionDto[]
}

/** 子 Agent 事件信封；`event` 是内层事件的原始载荷，形状由 `event_type` 决定。 */
export interface SubAgentEnvelopeDto {
  /** 子 Agent 的 ID。 */
  readonly agent_id: string
  /** 子 Agent 的展示名。 */
  readonly agent_name: string
  /** 本次子 Agent 执行的 ID。 */
  readonly execution_id: string
  /** 父 Agent 中触发本次子执行的工具调用 ID。 */
  readonly parent_call_id: string
  /** 内层事件的类型标识；决定 `event` 载荷的形状。 */
  readonly event_type: string
  /** 内层事件的原始载荷；形状由 `event_type` 决定，需先按类型分支再取值。 */
  readonly event: unknown
}
