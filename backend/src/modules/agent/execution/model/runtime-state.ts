import type { AgentJsonObject } from '../../model/json-value.js'

/** 后端持久化的 Runtime 状态信封；payload 对业务层保持不透明。 */
export interface StoredRuntimeState {
  /** 产出该快照的 Runtime 引擎标识；当前固定为 qing-tuan，供将来拒绝跨引擎重放。 */
  readonly engine: 'qing-tuan'
  /** checkpoint 版本号；反序列化时据此判断旧 payload 是否仍按当前引擎结构可读。 */
  readonly version: number
  /**
   * 引擎自有的不透明载荷（qing-tuan Checkpoint 的序列化结果）。
   * 业务层不得解读其内容，只能原样回传，SDK 结构变化因此被挡在 codec 一层。
   */
  readonly payload: AgentJsonObject
}
