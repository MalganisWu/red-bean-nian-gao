import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'

import { bindDownloadStreamToAbort } from '../../../../../src/modules/storage/service/object-storage/download-stream-lifecycle.js'

class TrackedReadable extends Readable {
  public destroyCalls = 0
  public destroyError: Error | undefined

  public constructor() {
    super({ autoDestroy: false })
  }

  public override _read(): void {}

  public override destroy(error?: Error): this {
    this.destroyCalls += 1
    this.destroyError = error
    return super.destroy(error)
  }
}

void describe('MinIO 下载流取消绑定', () => {
  void it('请求取消后销毁已经取得的下载流并保留取消原因', () => {
    const stream = new TrackedReadable()
    stream.on('error', (): void => undefined)
    const controller = new AbortController()
    const reason = new Error('client disconnected')

    bindDownloadStreamToAbort(stream, controller.signal)
    controller.abort(reason)

    assert.equal(stream.destroyCalls, 1)
    assert.equal(stream.destroyError, reason)
  })

  void it('绑定前已经取消时立即销毁下载流', () => {
    const stream = new TrackedReadable()
    const controller = new AbortController()
    const reason = new Error('already disconnected')
    controller.abort(reason)

    bindDownloadStreamToAbort(stream, controller.signal)

    assert.equal(stream.destroyCalls, 1)
    assert.equal(stream.destroyError, reason)
  })

  for (const terminalEvent of ['end', 'close', 'error'] as const) {
    void it(`${terminalEvent} 后解除取消监听，不再重复销毁流`, () => {
      const stream = new TrackedReadable()
      const controller = new AbortController()
      bindDownloadStreamToAbort(stream, controller.signal)

      stream.emit(terminalEvent, ...(terminalEvent === 'error' ? [new Error('read failed')] : []))
      controller.abort(new Error('late abort'))

      assert.equal(stream.destroyCalls, 0)
    })
  }
})
