import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDocumentables } from '../backend/scripts/architecture-syntax.mjs'
import { documentableViolations } from '../tooling/typescript/export-jsdoc-rules.mjs'

/**
 * 导出符号 JSDoc 门禁的产品仓入口。
 *
 * 判据是跨仓共享的纯规则模块 `tooling/typescript/export-jsdoc-rules.mjs`；本文件只负责
 * 选文件、跑规则、报错。四个 workspace 的源码都要扫，但本文件在仓库根 —— 产品仓根目录
 * 没有 `package.json`，解析不到编译器 API，所以语法层从 `backend/scripts/architecture-syntax.mjs`
 * 借：bare specifier 按**导入方文件位置**解析，那里的 `typescript` 是可解析的。
 *
 * **零容忍**：2026-10-13 的档 C 清理把存量 1183 条补齐后，棘轮基线已删除。原基线机制是
 * 「不在基线失败 + 基线里有而现场没有也失败 + 更新只允许裁剪」，维持它需要一份长期豁免
 * 清单；既然已归零，直接用零容忍更简单也更难绕过。确实需要引入新的存量豁免时，
 * 从 `docs/decisions/2026-10-13-export-jsdoc-gate.md` 恢复那套语义，不要放宽本文件。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scanRoots = ['backend/src', 'frontend/src', 'api-contract/src', 'design-system/src']
const fixturesPath = path.join(root, 'tooling/typescript/export-jsdoc-cases.json')

/** 递归列出扫描根下的 TypeScript 源码；声明文件不是源码。 */
function listSourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = path.join(directory, entry)
    if (statSync(full).isDirectory()) {
      files.push(...listSourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    if (entry.endsWith('.d.ts')) continue
    files.push(full)
  }
  return files
}

/** 现场违规，按 `{file, symbolPath, rule, param}` 形状返回；`file` 是仓库根相对路径。 */
function collectViolations() {
  const entries = []
  for (const scanRoot of scanRoots) {
    for (const file of listSourceFiles(path.join(root, scanRoot))) {
      const relative = path.relative(root, file).split(path.sep).join('/')
      for (const record of collectDocumentables(file)) {
        for (const violation of documentableViolations(record)) {
          entries.push({
            file: relative,
            symbolPath: record.symbolPath,
            rule: violation.rule,
            param: violation.param,
          })
        }
      }
    }
  }
  return entries
}

const failures = []

// 规则层自测：夹具是判据的可执行契约，夹具不过就不该相信后面的结论。
for (const testCase of JSON.parse(readFileSync(fixturesPath, 'utf8'))) {
  const violations = documentableViolations(testCase.record)
  if ((violations.length === 0) !== testCase.valid) {
    failures.push(
      `规则夹具 ${JSON.stringify(testCase.name)} 预期 valid=${String(testCase.valid)}，实际检测到 ${JSON.stringify(violations)}`
    )
  }
}

const violations = collectViolations()
for (const entry of violations) {
  failures.push(`[${entry.rule}] ${entry.file} — ${entry.symbolPath}`)
}

if (failures.length > 0) {
  console.error(`✗ 导出 JSDoc 违规 ${failures.length} 条：`)
  // 夹具失败通常只一两条，全列；符号违规可能很多，截断以免刷屏。
  const shown = failures.length > 40 ? failures.slice(0, 40) : failures
  for (const failure of shown) console.error(`  ${failure}`)
  if (shown.length < failures.length) {
    console.error(`  …还有 ${failures.length - shown.length} 条`)
  }
  console.error(
    '  要求：描述正文 + 逐参数 @param（非 void 显式返回再加 @returns）；判据见 tooling/typescript/export-jsdoc-rules.mjs'
  )
  process.exit(1)
}

console.log('✓ 导出符号与公开成员的 JSDoc 完整，无参数与返回 tag 缺失')
