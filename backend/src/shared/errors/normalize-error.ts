/** 把任意 unknown 值归一化为 Error；已是 Error 实例则原样返回。 */
export function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
