export type CloseHandler = (signal: AbortSignal) => Promise<void>

/** 统一持有进程资源，并保证按注册逆序且仅关闭一次。 */
export class Lifecycle {
  readonly #handlers: CloseHandler[] = []
  #closed = false
  #closePromise: Promise<void> | undefined

  public onClose(handler: CloseHandler | null | undefined): void {
    if (typeof handler !== 'function') {
      throw new Error('lifecycle close handler must be a function')
    }
    if (this.#closed) throw new Error('lifecycle is already closed')
    this.#handlers.push(handler)
  }

  public close(signal: AbortSignal): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise

    this.#closed = true
    this.#closePromise = this.#closeResources(signal)
    return this.#closePromise
  }

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
