import { API_ROUTES, type ApiRouteDefinition } from '@red-bean/api-contract'
import type { FastifyInstance } from 'fastify'

type RouteCatalog = Readonly<Record<string, ApiRouteDefinition>>

/** 路由目录对账句柄；只对账 method+path，认证钩子的一致性由 `bindRoute` 自己断言。 */
export interface RouteCatalogChecker {
  /** 在全部路由注册完成后调用；目录与实际注册表不一致时抛错（fail-fast）。 */
  verify(): void
}

/**
 * 启动期路由目录对账：先调用本函数注册收集钩子，完成 `registerApplicationRoutes`
 * 后再调用返回值的 `verify()`。比对 `expected` 目录与实际注册表（双向）：
 * - 目录有、实际无 → 端点漏注册；
 * - 实际有、目录无 → 存在绕过 bindRoute 的裸注册（路径/参数语法不一致同样暴露）。
 * 认证方向的钩子一致性由 `bindRoute` 的启动断言负责，本检查只对账 method+path。
 */
export function routeCatalogChecker(
  server: FastifyInstance,
  expected: RouteCatalog = API_ROUTES
): RouteCatalogChecker {
  const registered = new Map<string, string>()
  server.addHook('onRoute', (options): void => {
    const methods = Array.isArray(options.method) ? options.method : [options.method]
    for (const method of methods) {
      if (method === 'HEAD') continue // Fastify 为 GET 自动补 HEAD，非业务路由
      registered.set(`${method} ${options.url}`, options.url)
    }
  })

  return {
    verify(): void {
      const errors: string[] = []
      for (const [name, route] of Object.entries(expected)) {
        const key = `${route.method} ${route.path}`
        if (!registered.has(key)) {
          errors.push(`契约路由未注册：${key}（${name}）`)
        }
      }
      for (const key of registered.keys()) {
        const [method, path] = splitKey(key)
        const wired = Object.values(expected).some(
          (route) => route.method === method && route.path === path
        )
        if (!wired) errors.push(`存在不在契约目录中的注册：${key}`)
      }
      if (errors.length > 0) {
        throw new Error(
          `路由目录校验失败（${registered.size} 条已注册）：\n- ${errors.join('\n- ')}`
        )
      }
    },
  }
}

/** 校验已注册完成的服务器：便捷入口，等价于"先收集、后 verify"。 */
export function verifyRouteCatalog(server: FastifyInstance): void {
  routeCatalogChecker(server).verify()
}

function splitKey(key: string): readonly [string, string] {
  const separator = key.indexOf(' ')
  return [key.slice(0, separator), key.slice(separator + 1)]
}
