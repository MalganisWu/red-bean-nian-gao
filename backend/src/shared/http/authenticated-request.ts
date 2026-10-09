import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'

import type { TokenValidator } from '../authentication/token-validator.js'
import { unauthorizedError } from './error-mapper.js'
import { requestAbortSignal } from './fastify-http-boundary.js'

/** 经认证后绑定到单次 HTTP 请求的稳定调用身份。 */
export interface RequestPrincipal {
  readonly userId: string
}

const requestPrincipals = new WeakMap<FastifyRequest, RequestPrincipal>()

export interface AuthenticationOptions {
  /** Bearer 格式错误时返回给调用方的稳定中文提示。 */
  readonly malformedMessage?: string | undefined
}

/**
 * 建立统一的 HTTP 认证上下文。
 *
 * Token 校验仍由 Identity Module 拥有；这里仅把校验结果绑定到当前 Fastify request，
 * 避免各 Controller 各自维护 WeakMap 和略有差异的 Bearer 解析规则。
 */
export function authenticatedRequest(
  authService: TokenValidator,
  options: AuthenticationOptions = {}
): preHandlerAsyncHookHandler {
  return async (request): Promise<void> => {
    const authorization = firstHeader(request.headers.authorization)
    if (authorization === undefined || authorization === '') {
      throw unauthorizedError('缺少认证凭证')
    }
    if (!authorization.startsWith('Bearer ') || authorization.length === 'Bearer '.length) {
      throw unauthorizedError(options.malformedMessage ?? '认证头格式错误，应为 Bearer <token>')
    }
    try {
      const userId = await authService.validateToken(
        authorization.slice('Bearer '.length),
        requestAbortSignal(request)
      )
      if (userId === '') throw new Error('认证结果缺少用户 ID')
      requestPrincipals.set(request, Object.freeze({ userId }))
    } catch {
      throw unauthorizedError('认证凭证无效或已过期')
    }
  }
}

/** 读取由 authenticatedRequest 写入的当前身份；未经过认证前置处理器时拒绝访问。 */
export function authenticatedPrincipal(request: FastifyRequest): RequestPrincipal {
  const principal = requestPrincipals.get(request)
  if (principal === undefined) throw unauthorizedError('未授权')
  return principal
}

export function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0]
}
