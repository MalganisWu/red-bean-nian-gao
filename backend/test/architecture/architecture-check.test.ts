import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const backendRoot = resolve(process.cwd())
const checker = resolve(backendRoot, 'scripts/check-architecture.mjs')

void test('当前生产源码通过架构门禁', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, [checker], { encoding: 'utf8' }))
})

void test('拒绝 Controller 直接依赖 Adapter', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/controller/order.controller.ts',
      "import '../adapter/order.adapter.js'\n"
    )
    write(root, 'modules/order/adapter/order.adapter.ts', 'export class OrderAdapter {}\n')
    assertCheckerFails(root, 'controller-dependency')
  })
})

void test('拒绝 Port 依赖 Adapter 或 Service', () => {
  withFixture((root) => {
    write(root, 'modules/order/port/order.port.ts', "export * from '../adapter/order.adapter.js'\n")
    write(root, 'modules/order/adapter/order.adapter.ts', 'export class OrderAdapter {}\n')
    assertCheckerFails(root, 'layer-dependency')
  })
  withFixture((root) => {
    write(root, 'modules/order/port/order.port.ts', "export * from '../service/order.service.js'\n")
    write(root, 'modules/order/service/order.service.ts', 'export class OrderService {}\n')
    assertCheckerFails(root, 'layer-dependency')
  })
})

void test('拒绝 Service 依赖 Adapter', () => {
  withFixture((root) => {
    write(root, 'modules/order/service/order.service.ts', "import '../adapter/order.adapter.js'\n")
    write(root, 'modules/order/adapter/order.adapter.ts', 'export class OrderAdapter {}\n')
    assertCheckerFails(root, 'layer-dependency')
  })
})

void test('拒绝 Domain 与 Application 层依赖 Fastify', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/application/service/default-order-service.ts',
      "import type { FastifyRequest } from 'fastify'\nexport type Input = FastifyRequest\n"
    )
    assertCheckerFails(root, 'framework-dependency')
  })
})

void test('拒绝 Service 自行构造 Repository、Lifecycle 或 Adapter', () => {
  for (const dependency of ['OrderRepository', 'OrderLifecycle', 'OrderAdapter']) {
    withFixture((root) => {
      write(
        root,
        'modules/order/service/default-order-service.ts',
        `class ${dependency} {}\nexport class DefaultOrderService { readonly value = new ${dependency}() }\n`
      )
      assertCheckerFails(root, 'service-construction')
    })
  }
})

void test('拒绝绕过 public-api 的跨 Module 深层导入', () => {
  withFixture((root) => {
    write(root, 'modules/order/service/order.ts', "import '../../identity/model/user.js'\n")
    write(root, 'modules/identity/model/user.ts', 'export interface User {}\n')
    write(root, 'modules/identity/public-api.ts', "export type { User } from './model/user.js'\n")
    assertCheckerFails(root, 'module-boundary')
  })
})

void test('拒绝领域 public-api 导出 Controller 或 HTTP transport', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/public-api.ts',
      "export { registerOrderRoutes } from './controller/order.routes.js'\n"
    )
    write(
      root,
      'modules/order/controller/order.routes.ts',
      'export function registerOrderRoutes(): void {}\n'
    )
    assertCheckerFails(root, 'public-api-transport-export')
  })
})

void test('拒绝领域 public-api 暴露 Module 内部出站仓储', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/public-api.ts',
      "export type { OrderRepository } from './repository/port/order-repository.port.js'\n"
    )
    write(
      root,
      'modules/order/repository/port/order-repository.port.ts',
      'export interface OrderRepository {}\n'
    )
    assertCheckerFails(root, 'public-api-outbound-export')
  })
  withFixture((root) => {
    write(
      root,
      'modules/order/public-api.ts',
      "export { serializeOrder } from './serializer/order-serializer.js'\n"
    )
    write(
      root,
      'modules/order/serializer/order-serializer.ts',
      'export function serializeOrder(): object { return {} }\n'
    )
    assertCheckerFails(root, 'public-api-outbound-export')
  })
})

void test('拒绝 Service、Adapter 或 Model 转发权威类型', () => {
  for (const layer of ['service', 'adapter', 'model']) {
    withFixture((root) => {
      write(
        root,
        `modules/order/${layer}/legacy.ts`,
        "export type { OrderRepository } from '../port/order-repository.port.js'\n"
      )
      write(
        root,
        'modules/order/port/order-repository.port.ts',
        'export interface OrderRepository {}\n'
      )
      assertCheckerFails(root, 'implementation-type-re-export')
    })
  }
})

void test('拒绝 Routes 自行构造 Controller', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/controller/order.routes.ts',
      'class OrderController {}\nexport function registerOrderRoutes(): void { new OrderController() }\n'
    )
    assertCheckerFails(root, 'route-controller-construction')
  })
})

void test('拒绝 Module 组装没有显式 implements 的生产实现', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/order.module.ts',
      "import { DefaultOrderService } from './service/default-order-service.js'\nnew DefaultOrderService()\n"
    )
    write(
      root,
      'modules/order/service/default-order-service.ts',
      'export class DefaultOrderService {}\n'
    )
    assertCheckerFails(root, 'explicit-implements')
  })
})

void test('拒绝 Module 循环依赖', () => {
  withFixture((root) => {
    write(root, 'modules/alpha/public-api.ts', "export * from '../beta/public-api.js'\n")
    write(root, 'modules/beta/public-api.ts', "export * from '../alpha/public-api.js'\n")
    assertCheckerFails(root, 'module-cycle')
  })
})

void test('拒绝 Task 业务逻辑直接依赖 Runtime SDK', () => {
  withFixture((root) => {
    write(
      root,
      'modules/task/execution/service/default-task-execution.ts',
      "import type { RawMessage } from 'red-bean-qing-tuan/pipeline'\n"
    )
    assertCheckerFails(root, 'task-runtime-boundary')
  })
})

void test('拒绝白名单外的生产代码直接导入 Runtime SDK', () => {
  withFixture((root) => {
    write(
      root,
      'shared/http/server.ts',
      "import type { Tracer } from 'red-bean-qing-tuan/observability'\n"
    )
    write(root, 'modules/placeholder/public-api.ts', 'export {}\n')
    assertCheckerFails(root, 'runtime-sdk-import-boundary')
  })
})

void test('拒绝 public-api 通过业务 Model 暴露 Runtime SDK 类型', () => {
  withFixture((root) => {
    write(
      root,
      'modules/agent/public-api.ts',
      "export type { DisplayMessage } from './presentation/model/display-message.js'\n"
    )
    write(
      root,
      'modules/agent/presentation/model/display-message.ts',
      "import type { JsonValue } from 'red-bean-qing-tuan/pipeline'\nexport interface DisplayMessage { readonly sections: JsonValue }\n"
    )
    assertCheckerFails(root, 'public-api-runtime-leak')
  })
})

void test('拒绝 Adapter 导出类省略显式 implements', () => {
  withFixture((root) => {
    write(root, 'modules/task/delivery/adapter/redis-queue.ts', 'export class RedisQueue {}\n')
    assertCheckerFails(root, 'explicit-implements')
  })
})

void test('拒绝恢复旧源码和测试目录', () => {
  withFixture((root) => {
    const testRoot = join(root, '..', `${root.split('/').at(-1) ?? 'fixture'}-test`)
    try {
      write(root, 'modules/placeholder/public-api.ts', 'export {}\n')
      write(root, 'api/legacy.ts', 'export {}\n')
      write(testRoot, 'engine/legacy.test.ts', 'export {}\n')
      assertCheckerFails(root, 'legacy-source-directory', testRoot)
      assertCheckerFails(root, 'legacy-test-directory', testRoot)
    } finally {
      rmSync(testRoot, { recursive: true, force: true })
    }
  })
})

void test('拒绝 app 与 entrypoint 绕过 Module public-api 深层导入', () => {
  withFixture((root) => {
    write(root, 'modules/agent/public-api.ts', 'export {}\n')
    write(root, 'modules/agent/controller/chat.ts', 'export {}\n')
    write(root, 'app/composition-root.ts', "import '../modules/agent/controller/chat.js'\n")
    assertCheckerFails(root, 'application-module-boundary')
  })
})

void test('允许 app 通过受限 http-api 组装 driving adapter', () => {
  withFixture((root) => {
    write(root, 'modules/agent/http-api.ts', 'export function registerAgentRoutes(): void {}\n')
    write(
      root,
      'app/http-routes.ts',
      "import { registerAgentRoutes } from '../modules/agent/http-api.js'\nvoid registerAgentRoutes\n"
    )
    assert.doesNotThrow(() =>
      execFileSync(process.execPath, [checker, root, join(root, 'test')], {
        encoding: 'utf8',
        stdio: 'pipe',
      })
    )
  })
  withFixture((root) => {
    write(root, 'modules/agent/http-api.ts', 'export function registerAgentRoutes(): void {}\n')
    write(
      root,
      'app/composition-root.ts',
      "import { registerAgentRoutes } from '../modules/agent/http-api.js'\nvoid registerAgentRoutes\n"
    )
    assertCheckerFails(root, 'application-module-boundary')
  })
})

void test('拒绝 DTO 文件包含运行时函数或值', () => {
  withFixture((root) => {
    write(root, 'modules/order/controller/order.dto.ts', 'export function normalize(): void {}\n')
    assertCheckerFails(root, 'dto-purity')
  })
  withFixture((root) => {
    const contractRoot = join(root, 'contract')
    write(root, 'modules/order/public-api.ts', 'export {}\n')
    write(contractRoot, 'order/dto.ts', 'export const status = 1\n')
    assertCheckerFails(root, 'dto-purity', undefined, contractRoot)
  })
})

void test('拒绝 Port 和生产实现缺少中文职责 JSDoc', () => {
  withFixture((root) => {
    write(root, 'modules/order/port/order.port.ts', 'export interface OrderServicePort {}\n')
    assertCheckerFails(root, 'chinese-boundary-documentation')
  })
  withFixture((root) => {
    write(
      root,
      'modules/order/service/default-order-service.ts',
      'export class DefaultOrderService implements Disposable { [Symbol.dispose](): void {} }\n'
    )
    assertCheckerFails(root, 'chinese-boundary-documentation')
  })
})

void test('文件超过规模触发线时只提示人工审查', () => {
  withFixture((root) => {
    write(root, 'modules/order/controller/order.controller.ts', '// 占位\n'.repeat(201))
    const result = spawnSync(process.execPath, [checker, root, join(root, 'test')], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0)
    assert.match(result.stderr, /\[file-size-review\]/u)
  })
  withFixture((root) => {
    const testRoot = join(root, 'test')
    write(root, 'modules/order/public-api.ts', 'export {}\n')
    write(testRoot, 'modules/order/order.test.ts', '// 占位\n'.repeat(401))
    const result = spawnSync(process.execPath, [checker, root, testRoot], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0)
    assert.match(result.stderr, /order\.test\.ts: 402 行超过 400 行/u)
  })
})

void test('拒绝测试目录使用生产 Module 不存在的能力名称', () => {
  withFixture((root) => {
    const testRoot = join(root, '..', `${root.split('/').at(-1) ?? 'fixture'}-test`)
    try {
      write(root, 'modules/agent/cancellation/public-api.ts', 'export {}\n')
      write(testRoot, 'modules/agent/registry/legacy.test.ts', 'export {}\n')
      assertCheckerFails(root, 'test-capability-mirror', testRoot)
    } finally {
      rmSync(testRoot, { recursive: true, force: true })
    }
  })
})

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'architecture-check-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path)
  mkdirSync(resolve(target, '..'), { recursive: true })
  writeFileSync(target, content)
}

function assertCheckerFails(
  root: string,
  rule: string,
  testRoot?: string,
  contractRoot?: string
): void {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [checker, root, testRoot ?? join(root, 'test'), contractRoot ?? join(root, 'contract')],
        {
          encoding: 'utf8',
          stdio: 'pipe',
        }
      ),
    (error: unknown): boolean => {
      assert.ok(error instanceof Error)
      assert.ok('stderr' in error)
      assert.match(String(error.stderr), new RegExp(`\\[${rule}\\]`))
      return true
    }
  )
}
