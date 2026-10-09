import type { AgentJsonObject } from '../../model/json-value.js'

/** 后端持久化的 Runtime 状态信封；payload 对业务层保持不透明。 */
export interface StoredRuntimeState {
  readonly engine: 'qing-tuan'
  readonly version: number
  readonly payload: AgentJsonObject
}
