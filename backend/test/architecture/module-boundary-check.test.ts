import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const checker = resolve(process.cwd(), 'scripts/check-architecture.mjs')

void test('拒绝 platform、shared 与 infra 深层导入业务 Module', () => {
  for (const source of ['platform/provider.ts', 'shared/authenticated.ts', 'infra/connection.ts']) {
    withFixture((root) => {
      write(root, source, "import '../modules/order/model/order.js'\n")
      write(root, 'modules/order/model/order.ts', 'export interface Order {}\n')
      write(root, 'modules/order/public-api.ts', "export type { Order } from './model/order.js'\n")
      assertCheckerFails(root, 'non-module-module-boundary')
    })
  }
})

void test('拒绝业务 Module 反向依赖 app', () => {
  withFixture((root) => {
    write(root, 'modules/task/task.module.ts', "import type { AppTask } from '../../app/app.js'\n")
    write(root, 'app/app.ts', 'export type AppTask = () => void\n')
    assertCheckerFails(root, 'module-application-dependency')
  })
})

void test('拒绝 public-api 经 Module 返回契约间接暴露私有仓储', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/public-api.ts',
      "export { createOrderModule, type OrderModule } from './order.module.js'\n"
    )
    write(
      root,
      'modules/order/order.module.ts',
      [
        "import type { OrderRepository } from './repository/port/order-repository.port.js'",
        'export interface OrderModule { readonly repository: OrderRepository }',
        'export function createOrderModule(): OrderModule { throw new Error() }',
        '',
      ].join('\n')
    )
    write(
      root,
      'modules/order/repository/port/order-repository.port.ts',
      'export interface OrderRepository {}\n'
    )
    assertCheckerFails(root, 'public-api-indirect-outbound-leak')
  })
})

void test('递归拒绝 public-api 的工厂返回类型经多层内部接口暴露 Adapter', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/public-api.ts',
      "export { createOrderModule, type OrderModule } from './order.module.js'\n"
    )
    write(
      root,
      'modules/order/order.module.ts',
      [
        "import type { PostgresOrderRepository } from './repository/adapter/postgres-order-repository.js'",
        'interface OrderInternals { readonly repository: PostgresOrderRepository }',
        'interface OrderAssembly { readonly internals: OrderInternals }',
        'export interface OrderModule { readonly ready: boolean }',
        'export function createOrderModule(): OrderAssembly { throw new Error() }',
        '',
      ].join('\n')
    )
    write(
      root,
      'modules/order/repository/adapter/postgres-order-repository.ts',
      'export class PostgresOrderRepository {}\n'
    )
    assertCheckerFails(root, 'public-api-indirect-outbound-leak')
  })
})

void test('递归拒绝 public-api 经别名返回内部 serializer 与 ObjectStorage', () => {
  for (const [privatePath, privateType] of [
    ['presentation/serializer/private-serializer.ts', 'PrivateSerializer'],
    ['object-storage/port/object-storage.ts', 'ObjectStorage'],
  ] as const) {
    withFixture((root) => {
      write(
        root,
        'modules/order/public-api.ts',
        "export { createOrderModule } from './order.module.js'\n"
      )
      write(
        root,
        'modules/order/order.module.ts',
        [
          `import type { ${privateType} as HiddenDependency } from './${privatePath.replace(/\.ts$/u, '.js')}'`,
          'interface NestedAssembly { readonly dependency: HiddenDependency }',
          'type ModuleResult = NestedAssembly',
          'export function createOrderModule(): ModuleResult { throw new Error() }',
          '',
        ].join('\n')
      )
      write(root, `modules/order/${privatePath}`, `export interface ${privateType} {}\n`)
      assertCheckerFails(root, 'public-api-indirect-outbound-leak')
    })
  }
})

void test('资源流与健康 Port 的 JSDoc 必须说明适用的边界语义', () => {
  for (const [path, source] of [
    [
      'modules/storage/download/port/download.port.ts',
      [
        "import type { Readable } from 'node:stream'",
        '/** 下载能力；默认实现为 MinioDownload。 */',
        'export interface DownloadPort { download(signal: AbortSignal): Promise<Readable> }',
        '',
      ].join('\n'),
    ],
    [
      'modules/storage/health/port/storage-health.port.ts',
      [
        '/** 存储健康检查；默认实现为 DefaultStorageHealthService。 */',
        'export interface StorageHealthPort { check(signal: AbortSignal): Promise<void> }',
        '',
      ].join('\n'),
    ],
  ] as const) {
    withFixture((root) => {
      write(root, path, source)
      assertCheckerFails(root, 'port-contract-documentation')
    })
  }
})

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'module-boundary-check-'))
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

function assertCheckerFails(root: string, rule: string): void {
  assert.throws(
    () =>
      execFileSync(process.execPath, [checker, root, join(root, 'test'), join(root, 'contract')], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    (error: unknown): boolean => {
      assert.ok(error instanceof Error)
      assert.ok('stderr' in error)
      assert.match(String(error.stderr), new RegExp(`\\[${rule}\\]`))
      return true
    }
  )
}
