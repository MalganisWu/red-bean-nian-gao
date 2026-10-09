/** 给底层错误附加操作上下文，便于日志定位；保留原 cause 链。 */
export function contextualError(context: string, cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  return new Error(`${context}: ${error.message}`, { cause })
}
