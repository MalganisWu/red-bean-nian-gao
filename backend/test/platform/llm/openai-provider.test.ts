import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { OpenAiAdapter } from 'red-bean-qing-tuan/llm'

import { LlmProviderRegistry } from '../../../src/platform/llm/registry/llm-registry.js'
import { OPENAI_PROVIDER_PLUGIN } from '../../../src/platform/llm/provider/openai-provider.js'

void describe('OpenAI-compatible product provider', () => {
  void it('creates the Runtime public OpenAI adapter', () => {
    const registry = new LlmProviderRegistry([OPENAI_PROVIDER_PLUGIN])
    const adapter = registry.adapterFactory()(
      'openai',
      'secret',
      'https://api.deepseek.com/v1',
      'deepseek-chat'
    )
    assert.ok(adapter instanceof OpenAiAdapter)
  })
})
