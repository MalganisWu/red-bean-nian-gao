import type { AgentJsonObject, AgentJsonValue } from '../model/json-value.js'

/** 校验并复制不可信输入，使其进入产品 JSON 值域。 */
export function toAgentJsonValue(value: unknown): AgentJsonValue {
  return normalize(value, new Set<object>())
}

function normalize(value: unknown, ancestors: Set<object>): AgentJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON number must be finite')
    return value
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('value contains a circular JSON reference')
    ancestors.add(value)
    try {
      return value.map((item) => normalize(item, ancestors))
    } finally {
      ancestors.delete(value)
    }
  }
  if (typeof value !== 'object')
    throw new TypeError(`value of type ${typeof value} is not valid JSON`)
  return normalizeObject(value, ancestors)
}

function normalizeObject(value: object, ancestors: Set<object>): AgentJsonObject {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('value is not a plain JSON object')
  }
  if (ancestors.has(value)) throw new TypeError('value contains a circular JSON reference')
  ancestors.add(value)
  try {
    const result: Record<string, AgentJsonValue> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('JSON object contains a symbol key')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new TypeError('JSON object contains an accessor property')
      }
      result[key] = normalize(descriptor.value, ancestors)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}
