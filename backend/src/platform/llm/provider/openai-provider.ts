import { OpenAiAdapter } from 'red-bean-qing-tuan/llm'

import type { LlmProviderPlugin, LlmProviderRegistrar } from '../registry/llm-registry.js'

export const OPENAI_PROVIDER_PLUGIN: LlmProviderPlugin = Object.freeze({
  name: 'openai-compatible',
  register(registrar: LlmProviderRegistrar): void {
    registrar.provide(
      'openai',
      (apiKey: string, baseUrl: string, modelName: string): OpenAiAdapter =>
        new OpenAiAdapter({ apiKey, baseUrl, modelName })
    )
  },
})
