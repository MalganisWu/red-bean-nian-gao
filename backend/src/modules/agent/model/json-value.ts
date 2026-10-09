/** Agent 产品域可持久化的 JSON 标量。 */
export type AgentJsonPrimitive = boolean | null | number | string

/**
 * Agent 产品域自己的 JSON 值类型。
 *
 * 该类型用于展示投影、数据库 JSON 和跨 Module 契约，避免这些业务边界反向暴露 Runtime SDK 类型。
 */
export type AgentJsonValue = AgentJsonPrimitive | AgentJsonValue[] | AgentJsonObject

/** Agent 产品域可持久化的 JSON 对象。 */
export interface AgentJsonObject {
  readonly [key: string]: AgentJsonValue
}
