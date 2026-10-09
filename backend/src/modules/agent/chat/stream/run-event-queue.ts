/** Chat 用例与 HTTP SSE 之间的单生产者异步事件队列。 */
export class RunEventQueue<TValue> implements AsyncIterable<TValue> {
  readonly #values: TValue[] = []
  readonly #waiters: Array<() => void> = []
  readonly #capacity: number
  readonly #onOverflow: ((error: Error) => void) | undefined
  #closed = false
  #error: Error | undefined

  public constructor(capacity = 512, onOverflow?: (error: Error) => void) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('事件队列容量必须是正整数')
    this.#capacity = capacity
    this.#onOverflow = onOverflow
  }

  public push(value: TValue): void {
    if (this.#closed) return
    if (this.#values.length >= this.#capacity) {
      const error = new Error(`Chat 事件队列超过容量上限 ${String(this.#capacity)}`)
      this.fail(error)
      this.#onOverflow?.(error)
      return
    }
    this.#values.push(value)
    this.#wake()
  }

  public close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#wake()
  }

  public fail(error: Error): void {
    if (this.#closed) return
    this.#error = error
    this.#closed = true
    this.#wake()
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<TValue> {
    while (true) {
      const value = this.#values.shift()
      if (value !== undefined) {
        yield value
        continue
      }
      if (this.#closed) {
        if (this.#error !== undefined) throw this.#error
        return
      }
      await new Promise<void>((resolve): void => {
        this.#waiters.push(resolve)
      })
    }
  }

  #wake(): void {
    for (const resolve of this.#waiters.splice(0)) resolve()
  }
}
