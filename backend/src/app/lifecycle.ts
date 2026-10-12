/** 关闭处理器；按注册的逆序执行，整个 Lifecycle 也只关闭一次。 */
export type CloseHandler = (signal: AbortSignal) => Promise<void>

/** 统一持有进程资源，并保证按注册逆序且仅关闭一次。 */
export class Lifecycle {
  readonly #handlers: CloseHandler[] = []
  #closed = false
  #closePromise: Promise<void> | undefined

  /**
   * 登记一个关闭处理器。关闭开始后再登记直接抛错——
   * 一个在关闭之后才登记的处理器永远不会被执行，静默接受等于悄悄泄漏一个资源。
   */
  public onClose(handler: CloseHandler | null | undefined): void {
    if (typeof handler !== 'function') {
      throw new Error('lifecycle close handler must be a function')
    }
    if (this.#closed) throw new Error('lifecycle is already closed')
    this.#handlers.push(handler)
  }

  /** 幂等：并发或重复调用共享同一次关闭，不会重复释放同一批资源。 */
  public close(signal: AbortSignal): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise

    this.#closed = true
    this.#closePromise = this.#closeResources(signal)
    return this.#closePromise
  }

  /**
   * **逆序**释放（后创建的先关闭），并且逐个收集失败后再一次性抛出。
   * 中途抛出会让后面的资源全部漏关，因此每个 handler 的异常都被吞下留待汇总——
   * 关不掉的资源本身就说明进程状态已经不干净，此时最要紧的是把剩下的也关掉。
   */
  async #closeResources(signal: AbortSignal): Promise<void> {
    const errors: unknown[] = []
    for (const handler of this.#handlers.toReversed()) {
      try {
        await handler(signal)
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'close application lifecycle')
    }
  }
}
