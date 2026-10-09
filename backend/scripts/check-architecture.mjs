#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeArchitecture, analyzeArchitectureWarnings } from './architecture-rules.mjs'

const backendRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoot = resolve(process.argv[2] ?? resolve(backendRoot, 'src'))
const testRoot = resolve(process.argv[3] ?? resolve(backendRoot, 'test'))
const contractRoot = resolve(process.argv[4] ?? resolve(backendRoot, '../api-contract/src'))
const violations = analyzeArchitecture(sourceRoot, { testRoot, contractRoot })
const warnings = analyzeArchitectureWarnings(sourceRoot, testRoot)

for (const warning of warnings) {
  console.warn(`⚠ [file-size-review] ${warning.file}: ${warning.message}`)
}

if (violations.length === 0) {
  console.log(
    '架构检查通过：目录、公开边界、Controller 依赖、Module 边界、显式实现与循环依赖均符合规范。'
  )
  process.exit(0)
}

console.error(`架构检查失败，共 ${violations.length} 项：`)
for (const violation of violations) {
  console.error(`- [${violation.rule}] ${violation.file}: ${violation.message}`)
}
process.exit(1)
