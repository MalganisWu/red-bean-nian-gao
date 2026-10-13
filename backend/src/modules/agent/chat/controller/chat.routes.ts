import { API_ROUTES } from '@red-bean/api-contract'
import { Readable } from 'node:stream'
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify'

import { bindRoute } from '../../../../shared/http/bind-route.js'
import { authenticatedPrincipal } from '../../../../shared/http/authenticated-request.js'
import {
  requestAbortSignal,
  requestTraceId,
} from '../../../../shared/http/fastify-http-boundary.js'
import { sendOk, envelope } from '../../../../shared/http/response.js'
import type { ChatRequestContext, StartedChatRun } from '../model/chat-command.js'
import type { ChatController } from './chat.controller.js'
import {
  parseAnswerRequestDto,
  parseCancelRequestDto,
  parseChatRequestDto,
} from './chat-request-parser.js'
import { streamFrames } from './chat-stream.js'

/**
 * 路由文件承载端点、认证策略、请求解包与传输投影；
 * Controller 保持与 Fastify 解耦的用例签名（入参 DTO + 返回流对象），此处不内联任何 Schema/serializer。
 * 端点执行链路（Fastify 生命周期，自左向右）：onRequest(全局 Abort+CORS+trace)
 * → preHandler auth → handler zod 校验 → Controller 业务 → SSE 帧流 / 成功信封；
 * 错误由全局 setErrorHandler 统一输出。各端点差异见下方链路指纹注释。
 *
 * @param server - 目标 Fastify 实例，三条路由就地注册到它上面。
 * @param controller - Chat 用例控制器；本函数只接线，不持有其生命周期。
 * @param authenticate - 认证前置钩子，三条路由都必须挂上，缺失即等同于开放访问。
 */
export function registerChatRoutes(
  server: FastifyInstance,
  controller: ChatController,
  authenticate: preHandlerAsyncHookHandler
): void {
  // POST /api/agent/chat → ChatController.start（SSE 流式对话）
  // 链路：auth → zod 校验(parseChatRequestDto) → controller.start → SSE 帧流
  bindRoute(server, API_ROUTES.CHAT, {
    auth: authenticate,
    handler: (request, reply) => startChat(controller, request, reply),
  })
  // POST /api/agent/chat/cancel → ChatController.cancel
  // 链路：auth → zod 校验(parseCancelRequestDto) → controller.cancel → 信封
  bindRoute(server, API_ROUTES.CHAT_CANCEL, {
    auth: authenticate,
    handler: (request, reply) => cancelChat(controller, request, reply),
  })
  // POST /api/agent/chat/answer → ChatController.answer（interrupt 应答 / card 提交）
  // 链路：auth → zod 校验(parseAnswerRequestDto) → controller.answer → SSE 帧流
  bindRoute(server, API_ROUTES.CHAT_ANSWER, {
    auth: authenticate,
    handler: (request, reply) => answerChat(controller, request, reply),
  })
}

/**
 * POST /api/agent/chat：发起一轮流式对话，把运行结果投影为 SSE 帧流。
 * @param controller Chat 用例控制器，负责启动运行并交出运行句柄
 * @param request Fastify 请求，body 经 zod 校验后作为发起命令
 * @param reply Fastify 响应，转为 SSE 帧流后交出
 */
async function startChat(
  controller: ChatController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const run = await controller.start(parseChatRequestDto(request.body), chatContext(request))
  await sendSse(reply, requestAbortSignal(request), run)
}

/**
 * POST /api/agent/chat/cancel：按当前用户与 request_id 取消单个请求，返回成功信封。
 * @param controller Chat 用例控制器，把取消转发到取消注册表
 * @param request Fastify 请求，body 提供 request_id、认证主体提供 userId
 * @param reply Fastify 响应，承载成功信封
 */
async function cancelChat(
  controller: ChatController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(
      await controller.cancel(
        authenticatedPrincipal(request).userId,
        parseCancelRequestDto(request.body).request_id
      )
    )
  )
}

/**
 * POST /api/agent/chat/answer：提交询问卡片答案，把恢复运行投影为 SSE 帧流。
 * @param controller Chat 用例控制器，以 resume 语义恢复运行
 * @param request Fastify 请求，body 携带交互 ID 与答案
 * @param reply Fastify 响应，转为 SSE 帧流后交出
 */
async function answerChat(
  controller: ChatController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const run = await controller.answer(parseAnswerRequestDto(request.body), chatContext(request))
  await sendSse(reply, requestAbortSignal(request), run)
}

/**
 * 组装认证与链路上下文，三个端点共用。
 * @param request Fastify 请求，提供认证主体、traceId 与中止信号
 * @returns 发起命令所需的用户、链路与取消上下文
 */
function chatContext(request: FastifyRequest): ChatRequestContext {
  return {
    userId: authenticatedPrincipal(request).userId,
    traceId: requestTraceId(request),
    signal: requestAbortSignal(request),
  }
}

/**
 * SSE 传输投影：设置流式响应头、绑定断连清理，并把流对象输出为帧流。
 * 断连后的响应已不可写；运行失败会由 completion 与应用生命周期统一观测。
 * @param reply Fastify 响应，设置 SSE 响应头后交出帧流
 * @param disconnectSignal 客户端断连信号，触发时以断连原因关闭运行句柄
 * @param run 已启动的运行，提供帧流所需的事件迭代器与 start 事件
 */
async function sendSse(
  reply: FastifyReply,
  disconnectSignal: AbortSignal,
  run: StartedChatRun
): Promise<void> {
  /** 客户端断连：以断连原因关闭运行句柄；收尾失败无需再向已不可写的响应发数据。 */
  function onDisconnect(): void {
    void run.handle.close('client_disconnected').catch((): void => {
      // 断连后的运行收尾失败只记录，不向不可写的响应再发数据。
    })
  }
  disconnectSignal.addEventListener('abort', onDisconnect, { once: true })
  if (disconnectSignal.aborted) onDisconnect()
  reply.header('content-type', 'text/event-stream')
  reply.header('cache-control', 'no-cache')
  reply.header('connection', 'keep-alive')
  try {
    await reply
      .status(200)
      .send(Readable.from(streamFrames(run.handle, run.start, disconnectSignal)))
  } finally {
    disconnectSignal.removeEventListener('abort', onDisconnect)
  }
}
