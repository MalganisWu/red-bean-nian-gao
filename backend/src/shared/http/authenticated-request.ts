import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'

import type { TokenValidator } from '../authentication/token-validator.js'
import { unauthorizedError } from './error-mapper.js'
import { requestAbortSignal } from './fastify-http-boundary.js'

/** 经认证后绑定到单次 HTTP 请求的稳定调用身份。 */
export interface RequestPrincipal {
  /** 已认证用户的 ID；由 Bearer token 校验结果得出，失败时不会有本对象。 */
  readonly userId: string
}

/** 请求 → 身份的绑定表；键是请求对象，请求结束后条目随 WeakMap 自动回收。 */
const requestPrincipals = new WeakMap<FastifyRequest, RequestPrincipal>()

/** 认证钩子选项；目前只有 Bearer 格式错误时的提示文案可定制。 */
export interface AuthenticationOptions {
  /** Bearer 格式错误时返回给调用方的稳定中文提示。 */
  readonly malformedMessage?: string | undefined
}

/**
 * 建立统一的 HTTP 认证上下文。
 *
 * Token 校验仍由 Identity Module 拥有；这里仅把校验结果绑定到当前 Fastify request，
 * 避免各 Controller 各自维护 WeakMap 和略有差异的 Bearer 解析规则。
 * @param authService - 校验 Bearer token 并返回 userId 的服务；校验失败由本钩子统一映射为 401。
 * @param options - 钩子选项；目前只有 Bearer 格式错误时的提示文案可定制。
 * @returns 绑定该认证服务的 Fastify 异步 preHandler 钩子。
 */
export function authenticatedRequest(
  authService: TokenValidator,
  options: AuthenticationOptions = {}
): preHandlerAsyncHookHandler {
  return (request): Promise<void> => authenticateRequest(authService, options, request)
}

/**
 * 解析 Bearer 凭证并校验 token；成功后把身份绑定到当前请求，失败统一抛 401。
 * @param authService - 校验 Bearer token 并返回 userId 的服务；校验失败由本函数统一映射为 401。
 * @param options - 钩子选项；仅 Bearer 格式错误时的提示文案可定制。
 * @param request - 当前 Fastify 请求；认证成功后身份会绑定到它上面。
 */
async function authenticateRequest(
  authService: TokenValidator,
  options: AuthenticationOptions,
  request: FastifyRequest
): Promise<void> {
  const authorization = firstHeader(request.headers.authorization)
  if (authorization === undefined || authorization === '') {
    throw unauthorizedError('缺少认证凭证')
  }
  // 长度判断排除 `Authorization: Bearer `（有前缀但没 token），否则会把空串当凭证交给校验器。
  if (!authorization.startsWith('Bearer ') || authorization.length === 'Bearer '.length) {
    throw unauthorizedError(options.malformedMessage ?? '认证头格式错误，应为 Bearer <token>')
  }
  // 校验失败统一映射为「无效或已过期」，**不区分**签名错、过期、用户不存在等具体原因——
  // 区分它们等于给攻击者一个探测 token 状态的接口。
  // 空 userId 也走这里：校验器返回空串说明实现有问题，但对外仍是同一个不可用的结论。
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

/**
 * 读取由 `authenticatedRequest` 写入的当前身份；**没有就拒绝访问**。
 * fail-closed 而不是返回一个空身份：忘了挂 auth 钩子的路由会得到 401，
 * 而不是以一个「无人」的身份悄悄放行。
 * @param request - 当前 Fastify 请求。
 * @returns 本次请求已绑定的调用身份。
 */
export function authenticatedPrincipal(request: FastifyRequest): RequestPrincipal {
  const principal = requestPrincipals.get(request)
  if (principal === undefined) throw unauthorizedError('未授权')
  return principal
}

/**
 * 取 header 的首个值；同名 header 出现多次时 Fastify 给的是数组，这里统一取第一个。
 * @param value - header 的原始值，可能是字符串、字符串数组或 `undefined`。
 * @returns 首个字符串值；缺失时为 `undefined`。
 */
export function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0]
}
