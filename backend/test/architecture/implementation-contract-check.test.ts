import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const checker = resolve(process.cwd(), 'scripts/check-architecture.mjs')

void test('允许生产实现绑定同职责的源码 interface', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/order.module.ts',
      "import { DefaultPaymentService } from './payment/service/default-payment-service.js'\nnew DefaultPaymentService()\n"
    )
    write(
      root,
      'modules/order/payment/port/payment-service.port.ts',
      '/** 支付能力；默认实现为 DefaultPaymentService，由 order.module.ts 组装。 */\nexport interface PaymentServicePort {}\n'
    )
    write(
      root,
      'modules/order/payment/service/default-payment-service.ts',
      "import type { PaymentServicePort } from '../port/payment-service.port.js'\n/** 支付能力的默认实现。 */\nexport class DefaultPaymentService implements PaymentServicePort {}\n"
    )
    assert.doesNotThrow(() => runChecker(root))
  })
})

void test('允许同能力接口经别名和多级 public-api 转发后绑定', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/order.module.ts',
      "import { DefaultPaymentService } from './payment/service/default-payment-service.js'\nnew DefaultPaymentService()\n"
    )
    write(
      root,
      'modules/order/payment/service/default-payment-service.ts',
      "import type { PaymentContract as PaymentBoundary } from '../public-api.js'\n/** 支付能力的默认实现。 */\nexport class DefaultPaymentService implements PaymentBoundary {}\n"
    )
    write(
      root,
      'modules/order/payment/public-api.ts',
      "export type { PaymentContract } from './contract.js'\n"
    )
    write(
      root,
      'modules/order/payment/contract.ts',
      "export type { PaymentServicePort as PaymentContract } from './port/payment-service.port.js'\n"
    )
    write(
      root,
      'modules/order/payment/port/payment-service.port.ts',
      '/** 支付能力；默认实现为 DefaultPaymentService，由 order.module.ts 组装。 */\nexport interface PaymentServicePort {}\n'
    )
    assert.doesNotThrow(() => runChecker(root))
  })
})

void test('别名和多级转发不能隐藏接口属于另一能力', () => {
  withFixture((root) => {
    write(root, 'modules/order/order.module.ts', '')
    write(
      root,
      'modules/order/payment/service/default-payment-service.ts',
      "import type { AuditContract as PaymentBoundary } from '../contract.js'\n/** 支付能力的默认实现。 */\nexport class DefaultPaymentService implements PaymentBoundary {}\n"
    )
    write(
      root,
      'modules/order/payment/contract.ts',
      "export type { AuditPort as AuditContract } from '../audit/public-api.js'\n"
    )
    write(
      root,
      'modules/order/audit/public-api.ts',
      "export type { AuditPort } from './port/audit.port.js'\n"
    )
    write(
      root,
      'modules/order/audit/port/audit.port.ts',
      '/** 审计边界；默认实现由 order.module.ts 组装。 */\nexport interface AuditPort {}\n'
    )
    assertCheckerFails(root, 'implements-capability-mismatch')
  })
})

void test('拒绝生产实现用无关 interface 冒充对应 Port', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/order.module.ts',
      "import { DefaultPaymentService } from './payment/service/default-payment-service.js'\nnew DefaultPaymentService()\n"
    )
    write(
      root,
      'modules/order/lifecycle/port/disposable.port.ts',
      '/** 资源释放能力；默认实现由 order.module.ts 组装。 */\nexport interface Disposable {}\n'
    )
    write(
      root,
      'modules/order/payment/service/default-payment-service.ts',
      "import type { Disposable } from '../../lifecycle/port/disposable.port.js'\n/** 支付能力的默认实现。 */\nexport class DefaultPaymentService implements Disposable {}\n"
    )
    assertCheckerFails(root, 'implements-capability-mismatch')
  })
})

void test('拒绝同职责词但不同能力目录的 Port', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/order.module.ts',
      "import { DefaultPaymentService } from './payment/service/default-payment-service.js'\nnew DefaultPaymentService()\n"
    )
    write(
      root,
      'modules/order/audit/port/payment-audit.port.ts',
      '/** 支付审计边界；默认实现由 order.module.ts 组装。 */\nexport interface PaymentAuditPort {}\n'
    )
    write(
      root,
      'modules/order/payment/service/default-payment-service.ts',
      "import type { PaymentAuditPort } from '../../audit/port/payment-audit.port.js'\n/** 支付能力的默认实现。 */\nexport class DefaultPaymentService implements PaymentAuditPort {}\n"
    )
    assertCheckerFails(root, 'implements-capability-mismatch')
  })
})

void test('拒绝同角色后缀但属于另一能力的接口', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/order.module.ts',
      "import { DefaultPaymentService } from './payment/service/default-payment-service.js'\nnew DefaultPaymentService()\n"
    )
    write(
      root,
      'modules/order/billing/port/payment-service.port.ts',
      '/** 账单支付边界；默认实现由 order.module.ts 组装。 */\nexport interface PaymentServicePort {}\n'
    )
    write(
      root,
      'modules/order/payment/service/default-payment-service.ts',
      "import type { PaymentServicePort } from '../../billing/port/payment-service.port.js'\n/** 支付能力的默认实现。 */\nexport class DefaultPaymentService implements PaymentServicePort {}\n"
    )
    assertCheckerFails(root, 'implements-capability-mismatch')
  })
})

void test('拒绝生产实现把类型别名或不存在的声明写入 implements', () => {
  for (const contract of [
    '/** 支付契约。 */\nexport type PaymentServicePort = object\n',
    '/** 其他契约；默认实现为 OtherService，由 order.module.ts 组装。 */\nexport interface OtherServicePort {}\n',
  ]) {
    withFixture((root) => {
      write(
        root,
        'modules/order/order.module.ts',
        "import { DefaultPaymentService } from './payment/service/default-payment-service.js'\nnew DefaultPaymentService()\n"
      )
      write(root, 'modules/order/payment/port/payment-service.port.ts', contract)
      write(
        root,
        'modules/order/payment/service/default-payment-service.ts',
        "import type { PaymentServicePort } from '../port/payment-service.port.js'\n/** 支付能力的默认实现。 */\nexport class DefaultPaymentService implements PaymentServicePort {}\n"
      )
      assertCheckerFails(root, 'implements-source-interface')
    })
  }
})

void test('Module 使用实现类别名时仍必须追溯并校验精确接口', () => {
  withFixture((root) => {
    write(
      root,
      'modules/order/order.module.ts',
      "import { DefaultPaymentService as PaymentImplementation } from './payment/service/default-payment-service.js'\nnew PaymentImplementation()\n"
    )
    write(
      root,
      'modules/order/payment/service/default-payment-service.ts',
      '/** 遗漏 implements 的支付实现。 */\nexport class DefaultPaymentService {}\n'
    )
    assertCheckerFails(root, 'explicit-implements')
  })
})

void test('拒绝未被 Module new 但位于受管目录的导出实现省略 implements', () => {
  withFixture((root) => {
    write(root, 'modules/order/order.module.ts', '')
    write(
      root,
      'modules/order/payment/service/default-payment-service.ts',
      '/** 尚未接入 Module 的支付实现。 */\nexport class DefaultPaymentService {}\n'
    )
    assertCheckerFails(root, 'explicit-implements')
  })
})

void test('拒绝不再对应实际 implements 关系的跨能力白名单', () => {
  withFixture((root) => {
    write(
      root,
      'modules/agent/session/repository/adapter/memory-session-repository.ts',
      'export {}\n'
    )
    assertCheckerFails(root, 'stale-implementation-binding')
  })
})

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'implementation-contract-check-'))
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

function runChecker(root: string): string {
  return execFileSync(process.execPath, [checker, root, join(root, 'test')], {
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

function assertCheckerFails(root: string, rule: string): void {
  assert.throws(
    () => runChecker(root),
    (error: unknown): boolean => {
      assert.ok(error instanceof Error)
      assert.ok('stderr' in error)
      assert.match(String(error.stderr), new RegExp(`\\[${rule}\\]`))
      return true
    }
  )
}
