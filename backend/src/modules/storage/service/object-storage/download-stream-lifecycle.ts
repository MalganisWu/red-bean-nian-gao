import type { Readable } from 'node:stream'

/**
 * 将 HTTP 请求取消绑定到 MinIO 下载流，并在流结束、关闭或报错时解除监听，避免长生命周期信号持有流。
 */
export function bindDownloadStreamToAbort(body: Readable, signal: AbortSignal): void {
  const cleanup = (): void => {
    signal.removeEventListener('abort', onAbort)
    body.removeListener('end', cleanup)
    body.removeListener('close', cleanup)
    body.removeListener('error', cleanup)
  }
  const onAbort = (): void => {
    signal.removeEventListener('abort', onAbort)
    body.destroy(abortReason(signal))
  }
  body.once('end', cleanup)
  body.once('close', cleanup)
  body.once('error', cleanup)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('下载已取消')
}
