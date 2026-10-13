import type { API_ROUTES } from '@red-bean/api-contract'
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify'

/** 契约目录中的任一条路由定义（`API_ROUTES` 命名表的联合值类型）。 */
type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES]

/** 注册参数；`auth` 必须与端点目录的 `authenticated` 标志一致，不一致会在启动期直接失败。 */
export interface BindRouteOptions {
  /** 认证钩子：与清单 `authenticated` 标志机械绑定，缺失/多余时启动即失败（fail-fast）。 */
  readonly auth?: preHandlerAsyncHookHandler
  /** 其余前置钩子（限流等），按声明顺序在 auth 之后执行。 */
  readonly preHandler?: readonly preHandlerAsyncHookHandler[]
  readonly handler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
}

/**
 * 以端点目录命名表注册路由：直接传入 `API_ROUTES` 的成员（如 `API_ROUTES.REGISTER`），
 * method/path 全部取自该定义，后端路由文件不再出现路径字面量。
 * 传成员引用而非字符串键，是为了让 IDE 的 Go to Definition / Find Usages
 * 在目录与全部注册点之间双向可跳。
 * @param server - 目标 Fastify 实例。
 * @param route - `API_ROUTES` 的成员引用；其 method/path 就是注册用的路径。
 * @param options - 注册参数；`auth` 必须与端点的 `authenticated` 标志一致，否则启动期直接失败。
 */
export function bindRoute(
  server: FastifyInstance,
  route: ApiRoute,
  options: BindRouteOptions
): void {
  if (route.authenticated && options.auth === undefined) {
    throw new Error(`路由 ${route.path} 标记为需要认证（authenticated=true）但未提供 auth 钩子`)
  }
  if (!route.authenticated && options.auth !== undefined) {
    throw new Error(`路由 ${route.path} 标记为公开端点（authenticated=false）却提供了 auth 钩子`)
  }
  // preHandler 顺序固定为 auth 在前：Fastify 遇错短路，认证失败的请求不执行限流、
  // 不进入 handler——已认证请求才消耗限流配额。
  server.route({
    method: route.method,
    url: route.path,
    preHandler: [
      ...(options.auth === undefined ? [] : [options.auth]),
      ...(options.preHandler ?? []),
    ],
    handler: options.handler,
  })
}
