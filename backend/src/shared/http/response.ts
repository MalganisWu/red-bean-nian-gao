import type { ApiEnvelope } from '@red-bean/api-contract'
import type { FastifyReply } from 'fastify'

/** 组装统一成功信封；纯函数，不依赖 Fastify，可独立测试。 */
export function envelope<TData>(data: TData): ApiEnvelope<TData> {
  return { code: 200, data }
}

/**
 * 统一成功信封输出；错误信封仍由全局 setErrorHandler 兜底。
 * Controller 返回纯业务数据，路由层通过本函数投影为 `{ code, data }`。
 */
export function sendOk(
  reply: FastifyReply,
  body: ApiEnvelope<unknown>,
  statusCode = 200
): FastifyReply {
  return reply.status(statusCode).send(body)
}
