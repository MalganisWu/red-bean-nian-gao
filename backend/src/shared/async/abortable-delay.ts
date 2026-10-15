import { normalizeError } from '../errors/normalize-error.js'

/**
 * 等待指定毫秒数，或提前被 signal 中止（reject 中止原因）。
 * 定时器 unref，不阻止进程退出；监听在完成/中止后释放。
 * @param milliseconds - 等待时长，单位毫秒。
 * @param signal - 中止信号；已中止或等待期间中止时以 signal.reason 拒绝。
 */
export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(normalizeError(signal.reason))
  // 等待到期或被 abort 中止的 executor：定时器 unref，落定或中止后解绑监听。
  return new Promise<void>(function waitForDelayOrAbort(resolve, reject): void {
    // 取消：清掉定时器并以上游原因拒绝，避免等待方被定时器提前唤醒。
    function onAbort(): void {
      clearTimeout(timeout)
      reject(normalizeError(signal.reason))
    }
    // 到期：先解绑取消监听再兑现。
    function resolveWhenDue(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const timeout = setTimeout(resolveWhenDue, milliseconds)
    timeout.unref()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
