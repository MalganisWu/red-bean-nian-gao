import type { DisplayMessage } from '../../presentation/model/display-message.js'

/** 一次外部回合；`fencingToken` 由已持锁的调用方传入，不传则由 Writer 自行取锁并在提交后释放。 */
export interface ExternalSessionTurn {
  /** 目标会话标识；写入的 lease 与 fencing 都基于它。 */
  readonly sessionId: string
  /** 会话归属用户标识；取锁与校验归属都用到。 */
  readonly userId: string
  /** 外部调度的执行标识；用于识别重复投递（幂等命中）。 */
  readonly externalId: string
  /** 本轮用户输入正文；为空串表示不追加 user 运行消息。 */
  readonly userContent: string
  /** 本轮助手输出正文；为空串表示不追加 assistant 运行消息。 */
  readonly assistantContent: string
  /** 要并入会话的展示消息序列；写入时深拷贝后追加。 */
  readonly displayMessages: readonly DisplayMessage[]
  /** 已由调用方持有会话级 lease 时传入；Writer 仍负责 fence 校验与提交。 */
  readonly fencingToken?: bigint | undefined
}

/** 写入结果：`duplicate` 表示这次投递此前已落库（幂等命中），`deferred` 表示当前不可写、需稍后重试。 */
export type ExternalSessionTurnWriteResult = 'written' | 'duplicate' | 'deferred'

/**
 * Agent Module 拥有的外部回合写入边界，供 Task Module 向产品 Session 投递已完成结果。
 * 默认实现为 `DefaultExternalSessionTurnWriter`，由 `agent.module.ts` 的 `createAgentModuleCore()` 创建；
 * `app/composition-root.ts` 再将该实例跨模块注入 `task.module.ts`。
 * 默认实现独占 Session lease、fencing、Runtime State 追加、重复投递与待交互判断；未携带 fencing token
 * 时由 Writer 获取并释放 lease，调用方只解释 `written`、`duplicate`、`deferred` 结果并负责后续重试。
 */
export interface ExternalSessionTurnWriterPort {
  /**
   * 写入一个外部回合：独占 Session lease、做 fence 校验并提交。
   * 未携带 fencing token 时由 Writer 取锁并在提交后释放；调用方只需解释三种结果。
   *
   * @param turn - 外部回合数据；含 sessionId、externalId 与展示 / 运行消息。
   * @param signal - 中止信号，透传给仓储与锁。
   * @returns 写入结果：`written` / `duplicate`（幂等命中）/ `deferred`（当前不可写，稍后重试）。
   */
  write(turn: ExternalSessionTurn, signal: AbortSignal): Promise<ExternalSessionTurnWriteResult>
}
