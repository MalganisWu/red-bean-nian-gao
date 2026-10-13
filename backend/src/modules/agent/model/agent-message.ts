/** Agent 产品域保存的工具调用函数描述。 */
export interface AgentToolCallFunction {
  /** 被调用的工具名；与工具目录中的名称对应。 */
  readonly name: string
  /** 模型给出的参数原始 JSON 字符串；调用方解析后再校验。 */
  readonly arguments: string
}

/** Agent 产品域保存的工具调用。 */
export interface AgentToolCall {
  /** 同一批工具调用里的序号；流式增量拼接时用于对齐。 */
  readonly index?: number | undefined
  /** 本次调用的唯一标识；工具结果按它回填。 */
  readonly id: string
  /** 调用类型；当前恒为 `function`。 */
  readonly type: string
  /** 被调用的函数名与参数。 */
  readonly function: AgentToolCallFunction
}

/**
 * 普通对话、定时任务和 Sub-Agent 共用的产品消息。
 * Runtime Adapter 负责与 SDK RawMessage 双向转换，业务 Port 不直接暴露 SDK DTO。
 */
export interface AgentMessage {
  /** 消息角色（user / assistant / tool 等）；决定正文与工具字段的解释方式。 */
  readonly role: string
  /** 消息正文；null 表示该消息不携带正文（如纯工具调用轮次）。 */
  readonly content: string | null
  /** 本条消息发起的工具调用；仅 assistant 消息可能携带。 */
  readonly toolCalls?: readonly AgentToolCall[] | undefined
  /** 工具结果对应的调用标识；仅 tool 消息携带，用来回填到发起处。 */
  readonly toolCallId?: string | undefined
  /** 可选的参与者名；工具消息里标识工具名。 */
  readonly name?: string | undefined
}
