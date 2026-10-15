/**
 * 给底层错误附加操作上下文，便于日志定位；保留原 cause 链。
 *
 * @param context - 操作上下文前缀，拼在新错误的 message 最前面。
 * @param cause - 原始错误或任意抛出值；非 Error 会被转成字符串后再包一层。
 * @returns 带上下文的新 Error，原值挂在 `cause` 上，便于日志回溯根因。
 */
export function contextualError(context: string, cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  return new Error(`${context}：${error.message}`, { cause })
}
