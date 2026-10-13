import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  intentionallyDisabledRules,
  requiredCompilerOptions,
  requiredPackageScripts,
  typescriptSafetyRules,
} from '../tooling/typescript/policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

async function readJson(relativePath) {
  const source = await readFile(path.join(root, relativePath), 'utf8')
  return JSON.parse(source)
}

const baseConfig = await readJson('tooling/typescript/tsconfig.base.json')
for (const [name, expected] of Object.entries(requiredCompilerOptions)) {
  if (baseConfig.compilerOptions?.[name] !== expected) {
    failures.push(`tooling/typescript/tsconfig.base.json 缺少 ${name}: ${String(expected)}`)
  }
}

const packageConfigs = [
  {
    directory: 'api-contract',
    configs: [
      ['tsconfig.json', '../tooling/typescript/tsconfig.base.json'],
      ['tsconfig.build.json', './tsconfig.json'],
    ],
  },
  {
    directory: 'frontend',
    configs: [
      ['tsconfig.app.json', '../tooling/typescript/tsconfig.base.json'],
      ['tsconfig.node.json', '../tooling/typescript/tsconfig.base.json'],
      ['tsconfig.test.json', './tsconfig.app.json'],
    ],
  },
  {
    directory: 'design-system',
    configs: [
      ['tsconfig.app.json', '../tooling/typescript/tsconfig.base.json'],
      ['tsconfig.node.json', '../tooling/typescript/tsconfig.base.json'],
    ],
  },
  {
    directory: 'backend',
    configs: [
      ['tsconfig.json', '../tooling/typescript/tsconfig.base.json'],
      ['tsconfig.build.json', './tsconfig.json'],
      ['tsconfig.test.json', './tsconfig.json'],
    ],
  },
]

for (const packageConfig of packageConfigs) {
  const packageDir = packageConfig.directory
  const manifest = await readJson(`${packageDir}/package.json`)
  for (const scriptName of requiredPackageScripts) {
    if (typeof manifest.scripts?.[scriptName] !== 'string') {
      failures.push(`${packageDir}/package.json 缺少 scripts.${scriptName}`)
    }
  }
  if (
    packageDir === 'backend' &&
    !manifest.scripts.test.includes('".test-dist/test/**/*.test.js"')
  ) {
    failures.push('backend/package.json test 必须由 Node 展开递归 glob，避免漏跑深层测试')
  }

  for (const [configName, expectedParent] of packageConfig.configs) {
    const source = await readFile(path.join(root, packageDir, configName), 'utf8')
    if (!source.includes(expectedParent)) {
      failures.push(`${packageDir}/${configName} 未继承预期配置 ${expectedParent}`)
    }
  }

  const eslintConfig = await readFile(path.join(root, packageDir, 'eslint.config.js'), 'utf8')
  if (!eslintConfig.includes('../tooling/typescript/policy.mjs')) {
    failures.push(`${packageDir}/eslint.config.js 未加载共享政策`)
  }
  if (!eslintConfig.includes('strictTypeChecked')) {
    failures.push(`${packageDir}/eslint.config.js 未启用 strictTypeChecked`)
  }
}

for (const [ruleName, severity] of Object.entries(typescriptSafetyRules)) {
  const configuredSeverity = Array.isArray(severity) ? severity[0] : severity
  const expectedSeverity = intentionallyDisabledRules.includes(ruleName) ? 'off' : 'error'
  if (configuredSeverity !== expectedSeverity) {
    failures.push(`共享 ESLint 规则 ${ruleName} 必须为 error`)
  }
}

const makefile = await readFile(path.join(root, 'Makefile'), 'utf8')
for (const target of [
  'typecheck:',
  'ts-lint:',
  'ts-policy-check:',
  'ts-export-jsdoc-check:',
  'be-typecheck:',
  'be-lint:',
  'backend-ts-verify:',
  'verify:',
]) {
  if (!makefile.includes(target)) failures.push(`Makefile 缺少 ${target}`)
}

// workspace 命令必须从仓库根按包执行。若先 cd 到子包，pnpm 的版本管理器可能把
// 子包当成独立 workspace，导致 workspace:* 依赖无法解析。
for (const binding of [
  'PNPM := pnpm --filter frontend',
  'PNPM_DS := pnpm --filter design-system',
  'PNPM_BE := pnpm --filter @red-bean-nian-gao/backend',
  'PNPM_CONTRACT := pnpm --filter @red-bean/api-contract',
]) {
  if (!makefile.includes(binding)) failures.push(`Makefile 缺少根级 workspace 调用：${binding}`)
}

const workspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')
for (const directory of packageConfigs.map(({ directory }) => directory)) {
  if (!workspace.includes(`- ${directory}`)) {
    failures.push(`pnpm-workspace.yaml 缺少 package：${directory}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}

console.log('✓ TypeScript 严格配置、ESLint 政策、package scripts 与 Make 入口完整')
