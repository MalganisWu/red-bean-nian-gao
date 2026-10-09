/** Agent 产品域保存的工具调用函数描述。 */
export interface AgentToolCallFunction {
  readonly name: string
  readonly arguments: string
}

/** Agent 产品域保存的工具调用。 */
export interface AgentToolCall {
  readonly index?: number | undefined
  readonly id: string
  readonly type: string
  readonly function: AgentToolCallFunction
}

/**
 * 普通对话、定时任务和 Sub-Agent 共用的产品消息。
 * Runtime Adapter 负责与 SDK RawMessage 双向转换，业务 Port 不直接暴露 SDK DTO。
 */
export interface AgentMessage {
  readonly role: string
  readonly content: string | null
  readonly toolCalls?: readonly AgentToolCall[] | undefined
  readonly toolCallId?: string | undefined
  readonly name?: string | undefined
}
