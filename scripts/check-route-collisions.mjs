#!/usr/bin/env node
/**
 * 端点目录防撞检查（AGENTS.md R1/R2 规则的机械门禁）。
 *
 * 校验对象为 api-contract 构建产物的 API_ROUTES 命名表，规则：
 * 1. 同一父路径下，同一深度禁止静态段与参数段（:param / *）并存；
 * 2. 拒绝重复的 method + path。
 *
 * 用法：node scripts/check-route-collisions.mjs
 * 依赖：先构建 api-contract（make contract-build），dist/index.js 缺失时会给出明确提示。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const contractDist = resolve(
  fileURLToPath(new URL('../api-contract/dist/index.js', import.meta.url))
)
if (!existsSync(contractDist)) {
  console.error(
    '未找到 api-contract 构建产物，请先执行 make contract-build 或 make contract-test。'
  )
  process.exit(1)
}

const { API_ROUTES } = await import(contractDist)
const entries = Object.entries(API_ROUTES)

/** 段类型：静态 / 参数(:x) / 通配(*) */
function segmentKind(segment) {
  if (segment === '*') return 'wildcard'
  if (segment.startsWith(':')) return 'param'
  return 'static'
}

// 同一父路径下各深度出现的段类型集合
const parentKinds = new Map()
for (const [name, route] of entries) {
  const segments = route.path.split('/')
  const parent = segments.slice(0, -1).join('/') || '/'
  const last = segments[segments.length - 1]
  const kinds = parentKinds.get(parent) ?? new Set()
  kinds.add(segmentKind(last))
  parentKinds.set(parent, kinds)
}

const collisions = []
for (const [parent, kinds] of parentKinds) {
  if (kinds.has('static') && (kinds.has('param') || kinds.has('wildcard'))) {
    collisions.push(`${parent}/ 下同时存在静态段与 ${[...kinds].join('/')} 段`)
  }
}

// 重复 method+path 检测
const seen = new Map()
for (const [name, route] of entries) {
  const key = `${route.method} ${route.path}`
  const owner = seen.get(key)
  if (owner !== undefined) {
    collisions.push(`${key} 重复注册（${owner} 与 ${name}）`)
  }
  seen.set(key, name)
}

if (collisions.length === 0) {
  console.log(`路由防撞检查通过：共 ${entries.length} 条端点，无静态/参数段冲突。`)
  process.exit(0)
}

console.error(`路由防撞检查失败，共 ${collisions.length} 项：`)
for (const item of collisions) console.error(`- ${item}`)
process.exit(1)
