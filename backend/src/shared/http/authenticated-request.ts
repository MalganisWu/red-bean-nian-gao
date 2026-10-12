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
    // 长度判断排除 `Authorization: Bearer `（有前缀但没 token），否则会把空串当凭证交给校验器。
    if (!authorization.startsWith('Bearer ') || authorization.length === 'Bearer '.length) {
      throw unauthorizedError(options.malformedMessage ?? '认证头格式错误，应为 Bearer <token>')
    }
    /*
     * 校验失败统一映射为「无效或已过期」，**不区分**签名错、过期、用户不存在等具体原因——
     * 区分它们等于给攻击者一个探测 token 状态的接口。
     * 空 userId 也走这里：校验器返回空串说明实现有问题，但对外仍是同一个不可用的结论。
     */
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

/**
 * 读取由 `authenticatedRequest` 写入的当前身份；**没有就拒绝访问**。
 * fail-closed 而不是返回一个空身份：忘了挂 auth 钩子的路由会得到 401，
 * 而不是以一个「无人」的身份悄悄放行。
 */
export function authenticatedPrincipal(request: FastifyRequest): RequestPrincipal {
  const principal = requestPrincipals.get(request)
  if (principal === undefined) throw unauthorizedError('未授权')
  return principal
}

export function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0]
}
