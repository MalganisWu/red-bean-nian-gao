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
  /**
   * 发起新一轮对话；已有会话必须含本轮 user 消息，否则以 `missing_user_message` 拒绝。
   *
   * @param command - 发起命令；承载认证上下文、消息列表与可选的会话/agent 标识。
   * @returns 启动后的运行句柄与首帧 start 事件。
   */
  start(command: StartChatCommand): Promise<StartedChatRun>
  /**
   * 取消单个请求；幂等的尽力投递，目标运行已结束也不报错。
   *
   * @param command - 取消命令；userId 与 requestId 共同构成取消键。
   */
  cancel(command: CancelChatCommand): Promise<void>
  /**
   * 回答询问卡片：把答案包装成 resume 语义走与新建对话同一条流式出口。
   *
   * @param command - 回答命令；interactionId 必填。
   * @returns 恢复出的运行句柄与首帧 start 事件。
   */
  answer(command: AnswerChatCommand): Promise<StartedChatRun>
}

/**
 * 应用停机时用于取消并等待所有活动 Chat 收尾的生命周期边界。
 * 默认实现为 `DefaultChatService`，由 `agent.module.ts` 与 Chat 入站用例共用同一实例。
 */
export interface ChatRunLifecyclePort {
  /**
   * 停机排空：拒绝新启动、中止所有活动运行，并等待启动中与清理全部落地。
   *
   * @param signal - 调用方的等待上限信号；只约束本方法等多久，不决定要停哪些运行，已中止则立即抛出。
   */
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
