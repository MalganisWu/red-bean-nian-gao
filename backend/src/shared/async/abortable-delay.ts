import { normalizeError } from '../errors/normalize-error.js'

/**
 * 等待指定毫秒数，或提前被 signal 中止（reject 中止原因）。
 * 定时器 unref，不阻止进程退出；监听在完成/中止后释放。
 */
export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(normalizeError(signal.reason))
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(normalizeError(signal.reason))
    }
    const timeout = setTimeout((): void => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    timeout.unref()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
