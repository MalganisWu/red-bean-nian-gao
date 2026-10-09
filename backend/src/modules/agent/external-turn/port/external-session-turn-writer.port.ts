import type { DisplayMessage } from '../../presentation/model/display-message.js'

export interface ExternalSessionTurn {
  readonly sessionId: string
  readonly userId: string
  readonly externalId: string
  readonly userContent: string
  readonly assistantContent: string
  readonly displayMessages: readonly DisplayMessage[]
  /** 已由调用方持有会话级 lease 时传入；Writer 仍负责 fence 校验与提交。 */
  readonly fencingToken?: bigint | undefined
}

export type ExternalSessionTurnWriteResult = 'written' | 'duplicate' | 'deferred'

/**
 * Agent Module 拥有的外部回合写入边界，供 Task Module 向产品 Session 投递已完成结果。
 * 默认实现为 `DefaultExternalSessionTurnWriter`，由 `agent.module.ts` 的 `createAgentModuleCore()` 创建；
 * `app/composition-root.ts` 再将该实例跨模块注入 `task.module.ts`。
 * 默认实现独占 Session lease、fencing、Runtime State 追加、重复投递与待交互判断；未携带 fencing token
 * 时由 Writer 获取并释放 lease，调用方只解释 `written`、`duplicate`、`deferred` 结果并负责后续重试。
 */
export interface ExternalSessionTurnWriterPort {
  write(turn: ExternalSessionTurn, signal: AbortSignal): Promise<ExternalSessionTurnWriteResult>
}
