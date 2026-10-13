import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDocumentables } from '../backend/scripts/architecture-syntax.mjs'
import { baselineKey, documentableViolations } from '../tooling/typescript/export-jsdoc-rules.mjs'

/**
 * 导出符号 JSDoc 门禁的产品仓入口。
 *
 * 判据是跨仓共享的纯规则模块 `tooling/typescript/export-jsdoc-rules.mjs`；本文件只负责
 * 选文件、跑棘轮、报错。**棘轮不是"存量豁免"**，它同时约束三件事：
 *
 * 1. 不在基线里的违规 → 失败（挡住增长）；
 * 2. 基线里有、现场却没有的条目 → 失败（陈旧条目，让"烧到 0"成为机械强制）；
 * 3. `--update-baseline` **只能裁剪**，不接受新增键（否则一条命令就能把新违规洗白）。
 *
 * 三个 workspace 的源码都要扫，但本文件在仓库根 —— 产品仓根目录没有 `package.json`，
 * 解析不到编译器 API，所以语法层从 `backend/scripts/architecture-syntax.mjs` 借：
 * bare specifier 按**导入方文件位置**解析，那里的 `typescript` 是可解析的。
 *
 * 契约、代价与推进计划见 `docs/decisions/` 的档 C ADR。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scanRoots = ['backend/src', 'frontend/src', 'api-contract/src', 'design-system/src']
const baselinePath = path.join(root, 'testdata/architecture/export-jsdoc-baseline.json')
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

/** 现场违规，按基线条目形状返回；`file` 是仓库根相对路径，产品仓因此带 workspace 前缀。 */
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

function readBaseline() {
  if (!existsSync(baselinePath)) return { version: 1, entries: [] }
  return JSON.parse(readFileSync(baselinePath, 'utf8'))
}

function writeBaseline(entries) {
  const sorted = [...entries].sort((left, right) => baselineKey(left).localeCompare(baselineKey(right)))
  writeFileSync(baselinePath, `${JSON.stringify({ version: 1, entries: sorted }, undefined, 2)}\n`)
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
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}

const violations = collectViolations()
const violationKeys = new Set(violations.map(baselineKey))
const baseline = readBaseline()
const baselineKeys = new Set(baseline.entries.map(baselineKey))

// 建基线只允许在建仓那一次：文件已存在时必须走"只裁剪"路径，否则删文件就能洗白违规。
if (process.argv.includes('--seed-baseline')) {
  if (existsSync(baselinePath)) {
    console.error(
      `✗ 基线已存在，拒绝重新播种：${path.relative(root, baselinePath)}。改用 --update-baseline（只裁剪）。`
    )
    process.exit(1)
  }
  writeBaseline(violations)
  console.log(`✓ 已建立导出 JSDoc 基线：封存 ${violations.length} 条存量违规`)
  process.exit(0)
}

if (process.argv.includes('--update-baseline')) {
  const added = violations.filter((entry) => !baselineKeys.has(baselineKey(entry)))
  if (added.length > 0) {
    // 只裁剪、不新增：新增豁免必须手改 JSON，让它出现在 diff 的 + 行上。
    console.error(
      `✗ 基线只能裁剪：${added.length} 条新违规不在基线中，拒绝写入。要豁免请手动编辑 ${path.relative(root, baselinePath)}。`
    )
    for (const entry of added.slice(0, 20)) console.error(`  ${baselineKey(entry)}`)
    process.exit(1)
  }
  writeBaseline(violations)
  console.log(`✓ 已裁剪导出 JSDoc 基线：${baseline.entries.length} → ${violations.length} 条`)
  process.exit(0)
}

const added = violations.filter((entry) => !baselineKeys.has(baselineKey(entry)))
const stale = baseline.entries.filter((entry) => !violationKeys.has(baselineKey(entry)))

if (added.length > 0 || stale.length > 0) {
  if (added.length > 0) {
    console.error(`✗ 新增导出 JSDoc 违规 ${added.length} 条（基线中没有）：`)
    for (const entry of added.slice(0, 30)) {
      console.error(`  [${entry.rule}] ${entry.file} — ${entry.symbolPath}`)
    }
    if (added.length > 30) console.error(`  …还有 ${added.length - 30} 条`)
  }
  if (stale.length > 0) {
    console.error(`✗ 基线中有 ${stale.length} 条条目已不再违规（陈旧条目），请跑 --update-baseline 裁剪：`)
    for (const entry of stale.slice(0, 30)) {
      console.error(`  [${entry.rule}] ${entry.file} — ${entry.symbolPath}`)
    }
  }
  process.exit(1)
}

console.log(`✓ 导出 JSDoc 门禁通过：棘轮基线尚有 ${violations.length} 条待清理，无新增、无陈旧条目`)
