/**
 * Chat 用例与 HTTP SSE 之间的单生产者异步事件队列。
 *
 * **单生产者**是它的前提，也是实现可以这么简单的原因：没有并发写入，
 * 一个数组加一组等待者就够了，不需要真正的锁。
 *
 * 容量上限不是「丢弃策略」而是**故障信号**：事件是流式对话的唯一载体，
 * 丢掉一个 token 不会报错，只会让用户看到一个残缺的回答。所以溢出走 `fail` 而不是丢最旧的，
 * 让整次运行以明确的错误结束——宁可断掉，也不要静默给出错误的内容。
 */
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

  /**
   * 消费顺序：**先排空缓冲，再看是否已关闭**。
   * 这个顺序保证了 close/fail 之后仍能把已经入队的值交给消费者——
   * 先判关闭的话，运行结束时最后几个 token 会被直接丢掉。
   */
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

  /** 唤醒全部等待者。`splice(0)` 一次性取走并清空，避免重复唤醒已 resolve 的等待者。 */
  #wake(): void {
    for (const resolve of this.#waiters.splice(0)) resolve()
  }
}
