import type { AgentJsonObject, AgentJsonValue } from '../model/json-value.js'

/**
 * 校验并复制不可信输入，使其进入产品 JSON 值域。
 * @param value 不可信输入；非有限数值、循环引用、非纯对象或含访问器 / 符号键时抛 `TypeError`
 * @returns 深度复制后的产品 JSON 值（脱离原对象的引用）
 */
export function toAgentJsonValue(value: unknown): AgentJsonValue {
  return normalize(value, new Set<object>())
}

/**
 * 深度校验并复制单个值，是所有 JSON 值进入产品值域的收口。
 *
 * 合法形态（有限数字、字符串、布尔、数组、纯对象）复制为脱离原引用的新值，其余一律抛
 * `TypeError`，让不可信输入在边界处就被拒绝。`ancestors` 记录当前递归路径上的容器：
 * 进入容器时加入、退出时移除，命中则说明出现循环引用，必须报错而不是无限递归。
 *
 * @param value - 待校验的不可信输入
 * @param ancestors - 当前递归路径上的容器集合，用于循环引用检测
 * @returns 复制的产品 JSON 值；非法形态抛 `TypeError`
 */
function normalize(value: unknown, ancestors: Set<object>): AgentJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON 数字必须是有限值')
    return value
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('值中存在循环引用')
    ancestors.add(value)
    try {
      return value.map((item) => normalize(item, ancestors))
    } finally {
      ancestors.delete(value)
    }
  }
  if (typeof value !== 'object') throw new TypeError(`${typeof value} 类型的值不是合法 JSON`)
  return normalizeObject(value, ancestors)
}

/**
 * 处理对象分支：只接受原型为 `Object.prototype` 或 `null` 的纯对象，逐字段复制为新对象。
 *
 * 单独拆出来是因为对象走的是键遍历而非值判断，且要额外拒绝三类别名会污染值域的形状——
 * 非纯对象（会带上外部原型链）、符号键（JSON 表达不了，序列化时静默丢失）与访问器属性
 * （复制时执行 getter 可能触发副作用）。任一情况都抛 `TypeError` 而非尽力复制。
 *
 * @param value - 待校验的对象（调用方已确认是 object 且非数组）
 * @param ancestors - 当前递归路径上的容器集合，用于循环引用检测
 * @returns 复制的纯对象；非纯对象或含访问器 / 符号键时抛 `TypeError`
 */
function normalizeObject(value: object, ancestors: Set<object>): AgentJsonObject {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('值不是普通 JSON 对象')
  }
  if (ancestors.has(value)) throw new TypeError('值中存在循环引用')
  ancestors.add(value)
  try {
    const result: Record<string, AgentJsonValue> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('JSON 对象含有 symbol 键')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new TypeError('JSON 对象含有访问器属性')
      }
      result[key] = normalize(descriptor.value, ancestors)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}
