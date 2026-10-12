import { OpenAiAdapter } from 'red-bean-qing-tuan/llm'

import type { LlmProviderPlugin, LlmProviderRegistrar } from '../registry/llm-registry.js'

/**
 * OpenAI-compatible provider 插件。
 *
 * 注意两个名字**不相同**且各有用途，不是笔误：
 * - `plugin.name` = `openai-compatible`：插件自身的标识，用于去重与报错定位。
 * - `provide('openai', ...)` 的键 = `openai`：写入 `llm_configs.provider` 的值，是运行期查表用的。
 *   取 `openai` 而非 `openai-compatible`，是因为数据库里的存量配置就是这么写的。
 */
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
