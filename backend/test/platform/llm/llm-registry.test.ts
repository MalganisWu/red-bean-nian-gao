import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LlmAdapter, LlmChunk } from 'red-bean-qing-tuan/llm'

import {
  LlmProviderRegistry,
  type LlmProviderPlugin,
  type LlmProviderRegistrar,
} from '../../../src/platform/llm/registry/llm-registry.js'

class FakeAdapter implements LlmAdapter {
  public streamCompletion(): Promise<AsyncIterable<LlmChunk>> {
    return Promise.resolve(emptyChunks())
  }
}

function emptyChunks(): AsyncIterable<LlmChunk> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LlmChunk, undefined, undefined> {
      return {
        next(): Promise<IteratorResult<LlmChunk, undefined>> {
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
}

function plugin(
  name: string,
  register: (registrar: LlmProviderRegistrar) => void
): LlmProviderPlugin {
  return { name, register }
}

function validPlugin(name = 'valid'): LlmProviderPlugin {
  return plugin(name, (registrar): void => {
    registrar.provide('openai', (): LlmAdapter => new FakeAdapter())
  })
}

void describe('TypeScript LLM provider registry', () => {
  void it('normalizes provider names and forwards configuration', () => {
    const expected = new FakeAdapter()
    let received: readonly string[] = []
    const registry = new LlmProviderRegistry([
      plugin('test-provider', (registrar): void => {
        registrar.provide(' OpenAI ', (apiKey, baseUrl, modelName): LlmAdapter => {
          received = [apiKey, baseUrl, modelName]
          return expected
        })
      }),
    ])

    const adapter = registry.adapterFactory()(
      ' OPENAI ',
      'secret',
      'https://llm.example/v1',
      'model-a'
    )
    assert.equal(adapter, expected)
    assert.deepEqual(received, ['secret', 'https://llm.example/v1', 'model-a'])
  })

  void it('rejects invalid startup composition', () => {
    assert.throws(() => new LlmProviderRegistry([]), /at least one LLM provider/)
    assert.throws(() => new LlmProviderRegistry([null]), /plugin at index 0 must not be null/)
    assert.throws(
      () => new LlmProviderRegistry([plugin(' ', (): void => {})]),
      /name must not be empty/
    )
    assert.throws(
      () => new LlmProviderRegistry([validPlugin('valid'), validPlugin(' VALID ')]),
      /duplicate LLM provider plugin/
    )
    assert.throws(
      () =>
        new LlmProviderRegistry([
          plugin('empty-provider', (registrar): void => {
            registrar.provide(' ', (): LlmAdapter => new FakeAdapter())
          }),
        ]),
      /provider name must not be empty/
    )
    assert.throws(
      () =>
        new LlmProviderRegistry([
          plugin('missing-factory', (registrar): void => {
            registrar.provide('openai', null)
          }),
        ]),
      /factory must be a function/
    )
    assert.throws(
      () =>
        new LlmProviderRegistry([
          validPlugin('first'),
          plugin('second', (registrar): void => {
            registrar.provide(' OPENAI ', (): LlmAdapter => new FakeAdapter())
          }),
        ]),
      /already registered/
    )
    assert.throws(
      () =>
        new LlmProviderRegistry([
          plugin('broken', (): void => {
            throw new Error('registration failed')
          }),
        ]),
      /register LLM provider plugin "broken": registration failed/
    )
  })

  void it('rejects empty, unknown, and invalid provider results', () => {
    const registry = new LlmProviderRegistry([validPlugin()])
    const factory = registry.adapterFactory()
    assert.throws(() => factory(' ', '', '', ''), /provider name must not be empty/)
    assert.throws(() => factory('anthropic', '', '', ''), /unsupported LLM provider "anthropic"/)

    const invalid = new LlmProviderRegistry([
      plugin('invalid-result', (registrar): void => {
        registrar.provide('invalid', (): null => null)
      }),
    ])
    assert.throws(() => invalid.adapterFactory()('invalid', '', '', ''), /returned no adapter/)
  })

  void it('seals registration after startup', () => {
    let captured: LlmProviderRegistrar | undefined
    const registry = new LlmProviderRegistry([
      plugin('capture', (registrar): void => {
        captured = registrar
        registrar.provide('openai', (): LlmAdapter => new FakeAdapter())
      }),
    ])
    assert.ok(registry)
    if (captured === undefined) throw new Error('registrar was not captured')
    const sealedRegistrar = captured
    assert.throws(
      () => sealedRegistrar.provide('late', (): LlmAdapter => new FakeAdapter()),
      /registry is sealed/
    )
  })
})
