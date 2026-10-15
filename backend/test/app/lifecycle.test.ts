import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Lifecycle } from '../../src/app/lifecycle.js'

void describe('TypeScript backend lifecycle', () => {
  void it('closes resources once in reverse registration order', async () => {
    const calls: string[] = []
    const lifecycle = new Lifecycle()
    lifecycle.onClose((): Promise<void> => {
      calls.push('first')
      return Promise.resolve()
    })
    lifecycle.onClose((): Promise<void> => {
      calls.push('second')
      return Promise.resolve()
    })

    const signal = new AbortController().signal
    await Promise.all([lifecycle.close(signal), lifecycle.close(signal)])
    assert.deepEqual(calls, ['second', 'first'])
    await lifecycle.close(signal)
    assert.deepEqual(calls, ['second', 'first'])
  })

  void it('aggregates cleanup failures without skipping later resources', async () => {
    const calls: string[] = []
    const lifecycle = new Lifecycle()
    lifecycle.onClose((): Promise<void> => {
      calls.push('first')
      return Promise.reject(new Error('first failed'))
    })
    lifecycle.onClose((): Promise<void> => {
      calls.push('second')
      return Promise.reject(new Error('second failed'))
    })

    await assert.rejects(
      lifecycle.close(new AbortController().signal),
      (error: unknown): boolean => error instanceof AggregateError && error.errors.length === 2
    )
    assert.deepEqual(calls, ['second', 'first'])
  })

  void it('rejects invalid and late registration', async () => {
    const lifecycle = new Lifecycle()
    assert.throws(() => lifecycle.onClose(null), /必须是函数/)
    await lifecycle.close(new AbortController().signal)
    assert.throws(() => lifecycle.onClose((): Promise<void> => Promise.resolve()), /已经关闭/)
  })
})
