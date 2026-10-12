import type { AnswerRequestDto, ChatRequestDto } from './chat.dto.js'

import type {
  AnswerChatCommand,
  ChatRequestContext,
  StartChatCommand,
  StartedChatRun,
} from '../model/chat-command.js'
import { optionalField } from '../../../../shared/object/optional-field.js'
import type { ChatUseCasePort } from '../port/chat-use-case.port.js'
import { ChatUseCaseError } from '../port/chat-use-case.port.js'
import { SESSION_STORE_ERROR_CODES, SessionStoreError } from '../../session/model/session.js'
import { conflictError, validationError } from '../../../../shared/http/error-mapper.js'

/**
 * Chat 的 HTTP 用例控制器：方法签名即"入参 DTO + 认证上下文，返回流对象"，不接触 Fastify 类型；
 * 负责输入语义校验与应用错误映射。
 * 请求解包、SSE 传输投影（帧流输出、断连清理）与成功信封由 `chat.routes.ts` 承担。
 */
export class ChatController {
  readonly #chat: ChatUseCasePort

  public constructor(chat: ChatUseCasePort) {
    this.#chat = chat
  }

  /**
   * 发起对话。只翻译**这一层能理解**的错误码，其余原样上抛——
   * 应用层错误没有 HTTP 语义，把它映射成状态码是 Controller 的职责；
   * 而基础设施错误该由全局错误处理器统一兜底，在这里顺手转换只会丢掉原始类型。
   */
  public async start(input: ChatRequestDto, context: ChatRequestContext): Promise<StartedChatRun> {
    try {
      return await this.#chat.start(this.#startCommand(input, context))
    } catch (cause: unknown) {
      if (cause instanceof ChatUseCaseError && cause.code === 'missing_user_message') {
        throw validationError('已有会话的 messages 必须包含本轮 user 消息')
      }
      throw cause
    }
  }

  public async cancel(userId: string, requestId: string): Promise<{ readonly message: string }> {
    await this.#chat.cancel({ userId, requestId })
    return { message: '取消信号已发送' }
  }

  public async answer(
    input: AnswerRequestDto,
    context: ChatRequestContext
  ): Promise<StartedChatRun> {
    try {
      return await this.#chat.answer(this.#answerCommand(input, context))
    } catch (cause: unknown) {
      if (
        cause instanceof SessionStoreError &&
        cause.code === SESSION_STORE_ERROR_CODES.INTERACTION_CONFLICT
      ) {
        throw conflictError('交互不存在或已处理')
      }
      throw cause
    }
  }

  /**
   * 组装发起命令：认证上下文的三个字段显式写出，可选字段按 wire 语义映射。
   * 命令字段一次给全——调用点读方法名即知传的是什么，不必回翻 `ChatRequestContext` 来源。
   */
  #startCommand(input: ChatRequestDto, context: ChatRequestContext): StartChatCommand {
    return {
      userId: context.userId,
      traceId: context.traceId,
      signal: context.signal,
      ...optionalField('sessionId', input.session_id),
      ...optionalField('agentId', input.agent_id),
      messages: input.messages,
    }
  }

  /** 组装回答命令：`sessionId` 与 `interactionId` 必填，其余可选字段按 wire 语义映射。 */
  #answerCommand(input: AnswerRequestDto, context: ChatRequestContext): AnswerChatCommand {
    return {
      userId: context.userId,
      traceId: context.traceId,
      signal: context.signal,
      sessionId: input.session_id,
      ...optionalField('agentId', input.agent_id),
      interactionId: input.interaction_id,
      ...optionalField('answers', input.answers),
      ...optionalField('refused', input.refused),
    }
  }
}
