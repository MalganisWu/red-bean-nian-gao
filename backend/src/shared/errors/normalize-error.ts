/**
 * 把任意 unknown 值归一化为 Error；已是 Error 实例则原样返回。
 * @param value - 待归一化的值；`Error` 实例原样返回，其余包成 `Error`。
 * @returns 可直接用于日志与 `cause` 的 Error 实例。
 */
export function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
