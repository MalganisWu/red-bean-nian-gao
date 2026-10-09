import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ServerApplication,
  buildManaged,
  type HttpServer,
} from '../../src/app/server-application.js'
import { Lifecycle } from '../../src/app/lifecycle.js'

class FailingServer implements HttpServer {
  readonly #serveError: Error

  public constructor(serveError: Error) {
    this.#serveError = serveError
  }

  public listen(): Promise<void> {
    return Promise.reject(this.#serveError)
  }

  public shutdown(): Promise<void> {
    return Promise.resolve()
  }

  public close(): Promise<void> {
    return Promise.resolve()
  }
}

class BlockingServer implements HttpServer {
  public readonly started: Promise<void>
  readonly #markStarted: () => void
  readonly #stopped: Promise<void>
  readonly #markStopped: () => void

  public constructor() {
    const started = deferred()
    this.started = started.promise
    this.#markStarted = started.resolve
    const stopped = deferred()
    this.#stopped = stopped.promise
    this.#markStopped = stopped.resolve
  }

  public listen(): Promise<void> {
    this.#markStarted()
    return this.#stopped
  }

  public shutdown(): Promise<void> {
    this.#markStopped()
    return Promise.resolve()
  }

  public close(): Promise<void> {
    this.#markStopped()
    return Promise.resolve()
  }
}

void describe('TypeScript server application lifecycle', () => {
  void it('closes a partially built graph and preserves both errors', async () => {
    const buildError = new Error('build failed')
    const closeError = new Error('close failed')
    let closed = false

    await assert.rejects(
      buildManaged(async (lifecycle): Promise<object> => {
        lifecycle.onClose((): Promise<void> => {
          closed = true
          return Promise.reject(closeError)
        })
        return Promise.reject(buildError)
      }),
      (error: unknown): boolean =>
        containsError(error, buildError) && containsError(error, closeError)
    )
    assert.equal(closed, true)
  })

  void it('preserves serve and resource close failures', async () => {
    const serveError = new Error('serve failed')
    const closeError = new Error('close failed')
    const lifecycle = new Lifecycle()
    lifecycle.onClose((): Promise<void> => Promise.reject(closeError))
    const application = new ServerApplication({
      server: new FailingServer(serveError),
      lifecycle,
    })

    await assert.rejects(
      application.run(new AbortController().signal),
      (error: unknown): boolean =>
        containsError(error, serveError) && containsError(error, closeError)
    )
  })

  void it('drains and waits for background work before closing resources', async () => {
    const server = new BlockingServer()
    const lifecycle = new Lifecycle()
    const backgroundStarted = deferred()
    const backgroundStopped = deferred()
    let draining = false
    let resourceClosed = false
    let chatRunsDrained = false
    lifecycle.onClose((): Promise<void> => {
      assert.equal(resourceClosed, false)
      resourceClosed = true
      return backgroundStopped.promise
    })
    const application = new ServerApplication({
      server,
      lifecycle,
      health: {
        setDraining(value: boolean): void {
          draining = value
        },
      },
      backgroundTasks: [
        (signal): Promise<void> => {
          backgroundStarted.resolve()
          if (signal.aborted) {
            backgroundStopped.resolve()
            return Promise.resolve()
          }
          return new Promise((resolve): void => {
            signal.addEventListener(
              'abort',
              (): void => {
                backgroundStopped.resolve()
                resolve()
              },
              { once: true }
            )
          })
        },
      ],
      shutdownTasks: [
        (): Promise<void> => {
          chatRunsDrained = true
          return Promise.resolve()
        },
      ],
    })

    const controller = new AbortController()
    const running = application.run(controller.signal)
    await Promise.all([server.started, backgroundStarted.promise])
    controller.abort()
    await running
    assert.equal(draining, true)
    assert.equal(chatRunsDrained, true)
    assert.equal(resourceClosed, true)
  })
})

function containsError(value: unknown, expected: Error): boolean {
  if (value === expected) return true
  if (!(value instanceof AggregateError)) return false
  return value.errors.some((error: unknown): boolean => containsError(error, expected))
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {
    throw new Error('deferred promise resolved before initialization')
  }
  const promise = new Promise<void>((resolvePromise): void => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
