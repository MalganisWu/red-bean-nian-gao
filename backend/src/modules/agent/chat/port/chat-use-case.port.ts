import type {
  AnswerChatCommand,
  CancelChatCommand,
  StartedChatRun,
  StartChatCommand,
} from '../model/chat-command.js'

/**
 * Chat 的唯一入站用例边界；默认实现为 `DefaultChatService`，由 `agent.module.ts` 组装。
 * 命令类型定义位于 `model/chat-command.ts`，不随接口文件混杂纯类型。
 */
export interface ChatUseCasePort {
  start(command: StartChatCommand): Promise<StartedChatRun>
  cancel(command: CancelChatCommand): Promise<void>
  answer(command: AnswerChatCommand): Promise<StartedChatRun>
}

/**
 * 应用停机时用于取消并等待所有活动 Chat 收尾的生命周期边界。
 * 默认实现为 `DefaultChatService`，由 `agent.module.ts` 与 Chat 入站用例共用同一实例。
 */
export interface ChatRunLifecyclePort {
  shutdown(signal: AbortSignal): Promise<void>
}

/** 应用层可预期的 Chat 输入错误，不携带 HTTP 状态语义。 */
export class ChatUseCaseError extends Error {
  /** 稳定错误码，供 Controller 做分支翻译；当前只承载 `missing_user_message` 一种语义。 */
  public readonly code: 'missing_user_message'

  public constructor(code: 'missing_user_message', message: string) {
    super(message)
    this.name = 'ChatUseCaseError'
    this.code = code
  }
}
