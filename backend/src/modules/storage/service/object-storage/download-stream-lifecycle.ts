import type { Readable } from 'node:stream'

/**
 * 将 HTTP 请求取消绑定到 MinIO 下载流，并在流结束、关闭或报错时解除监听，避免长生命周期信号持有流。
 *
 * 流的所有权说明：本函数不消费流，只搭一条「取消 → 销毁」的单向通路；正常路径下由流自身的
 * end/close/error 触发解绑，被取消时立即 `destroy` 上游连接，防止半读连接泄漏。
 *
 * @param body - 待托管的下载流；调用方保留消费权，本函数只负责在取消时销毁它
 * @param signal - 请求生命周期信号；它可能长期存活，因此流终结后必须解除监听
 */
export function bindDownloadStreamToAbort(body: Readable, signal: AbortSignal): void {
  // 流已自然结束：摘掉全部监听，不再保持与长生命周期信号的联动。
  function cleanup(): void {
    signal.removeEventListener('abort', onAbort)
    body.removeListener('end', cleanup)
    body.removeListener('close', cleanup)
    body.removeListener('error', cleanup)
  }
  // 请求被取消：摘掉监听并销毁下载流，避免泄漏上游连接。
  function onAbort(): void {
    signal.removeEventListener('abort', onAbort)
    body.destroy(abortReason(signal))
  }
  body.once('end', cleanup)
  body.once('close', cleanup)
  body.once('error', cleanup)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
}

/**
 * 取取消信号携带的原因作为流的销毁理由，非 Error 时回落为固定文案。
 *
 * 保留原始 `reason` 是为了让下游能看见取消的真实来源；`AbortController.abort()` 不带参数时
 * `reason` 会是默认的 DOMException，仍属 Error，因此只有非 Error 的取值才需要兜底。
 *
 * @param signal - 已进入 aborted 状态的取消信号
 * @returns 可直接传给 `Readable.destroy` 的错误对象
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('下载已取消')
}
