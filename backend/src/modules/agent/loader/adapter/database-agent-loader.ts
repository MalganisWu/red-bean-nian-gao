import { z } from 'zod'

import type { SqlExecutor } from '../../../../infra/database/postgres.js'
import type {
  AgentBuildConfig,
  AgentLoadContext,
  AgentLoader,
  ChildRuntimeDecorator,
  ChildRuntimeDecoratableAgentLoader,
} from '../port/agent-loader.port.js'
import { SubExecDisplayRegistry } from '../../subagent/service/subagent-display.js'
import type { ToolRegistry } from '../../../../platform/tool/registry/tool-registry.js'
import type {
  BuildSubAgentToolsRequest,
  RuntimeSubAgentToolFactory,
  SubAgentToolDefinition,
} from '../../subagent/tool-factory/adapter/runtime-subagent-tool-factory.js'
import { createRuntimeDefaultRestorer } from '../../execution/adapter/runtime-compression-adapter.js'
import type {
  AgentModelAdapterFactory,
  AgentModelParams,
  AgentRuntimeConfig,
} from '../../execution/model/agent-execution-contract.js'

const jsonRecordSchema = z.record(z.string(), z.unknown())
const coreAgentRowSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  system_prompt: z.string(),
  llm_config_name: z.string().min(1),
  sys_tool_ids: z.array(z.string()),
  available_agent_ids: z.array(z.string()),
  model_params: jsonRecordSchema,
  metadata: jsonRecordSchema,
  is_active: z.boolean(),
})
const llmConfigRowSchema = z.object({
  llm_config_id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  model_name: z.string().min(1),
  credential_id: z.string().nullable(),
})
const credentialRowSchema = z.object({
  api_credential_id: z.string().min(1),
  api_base_url: z.string(),
  api_key: z.string(),
})

type CoreAgentRow = z.infer<typeof coreAgentRowSchema>
type LlmConfigRow = z.infer<typeof llmConfigRowSchema>

export interface DbMainAgentLoaderOptions {
  readonly database: SqlExecutor
  readonly registry: ToolRegistry
  readonly adapterFactory: AgentModelAdapterFactory
  readonly subAgentToolFactory: RuntimeSubAgentToolFactory
}

/** 从产品数据表加载一次运行所需的不可变配置快照。 */
export class DbMainAgentLoader implements ChildRuntimeDecoratableAgentLoader {
  readonly #options: DbMainAgentLoaderOptions

  public constructor(options: DbMainAgentLoaderOptions) {
    this.#options = options
  }

  public withChildRuntimeDecorator(decorator: ChildRuntimeDecorator): AgentLoader {
    return new DbMainAgentLoader({
      ...this.#options,
      subAgentToolFactory: this.#options.subAgentToolFactory.withRuntimeDecorator(decorator),
    })
  }

  public async load(
    agentId: string,
    signal: AbortSignal,
    context: AgentLoadContext = {}
  ): Promise<AgentBuildConfig> {
    const agent = await this.#loadAgent(agentId, signal)
    if (!agent.is_active) throw new Error(`agent ${JSON.stringify(agentId)} 已禁用`)
    const llmConfig = await this.#loadLlmConfig(agent.llm_config_name, signal)
    const credential =
      llmConfig.credential_id === null || llmConfig.credential_id === ''
        ? undefined
        : await this.#loadCredential(llmConfig.credential_id, signal)
    const adapter = this.#options.adapterFactory(
      llmConfig.provider,
      credential?.api_key ?? '',
      credential?.api_base_url ?? '',
      llmConfig.model_name
    )
    const modelParams = parseModelParams(agent.model_params)
    const runtimeConfig = parseRuntimeConfig(agent.metadata)
    const displayRegistry = new SubExecDisplayRegistry()
    const childDefinitions = await this.#loadChildDefinitions(agent.available_agent_ids, signal)
    const buildRequest: BuildSubAgentToolsRequest = {
      definitions: childDefinitions,
      parentAdapter: adapter,
      modelName: llmConfig.model_name,
      modelParams,
      runtimeConfig,
      displayRegistry,
      loadContext: context,
    }
    const delegation = this.#options.subAgentToolFactory.build(buildRequest)
    const systemTools = this.#options.registry.schemas(agent.sys_tool_ids)
    return {
      llmAdapter: adapter,
      toolDispatcher: this.#options.registry.compositeDispatcher(
        agent.sys_tool_ids,
        delegation.dispatcher
      ),
      tools: [...systemTools, ...delegation.schemas],
      systemPrompt: agent.system_prompt,
      modelParams,
      runtimeConfig,
      subAgentDisplayRegistry: displayRegistry,
      provider: llmConfig.provider,
      model: llmConfig.model_name,
    }
  }

  async #loadAgent(agentId: string, signal: AbortSignal): Promise<CoreAgentRow> {
    const result = await this.#options.database.query(
      `SELECT agent_id, name, description, system_prompt, llm_config_name,
              sys_tool_ids, available_agent_ids, model_params, metadata, is_active
       FROM core_agents WHERE agent_id = $1`,
      [agentId],
      signal
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error(`agent ${JSON.stringify(agentId)} 不存在`)
    return parseRow(coreAgentRowSchema, row, 'core_agents')
  }

  async #loadLlmConfig(name: string, signal: AbortSignal): Promise<LlmConfigRow> {
    const result = await this.#options.database.query(
      `SELECT llm_config_id, name, provider, model_name, credential_id
       FROM llm_configs WHERE name = $1`,
      [name],
      signal
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error(`llm_config ${JSON.stringify(name)} 不存在`)
    return parseRow(llmConfigRowSchema, row, 'llm_configs')
  }

  async #loadCredential(
    id: string,
    signal: AbortSignal
  ): Promise<z.infer<typeof credentialRowSchema>> {
    const result = await this.#options.database.query(
      `SELECT api_credential_id, api_base_url, api_key
       FROM api_credentials WHERE api_credential_id = $1`,
      [id],
      signal
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error(`credential ${JSON.stringify(id)} 不存在`)
    return parseRow(credentialRowSchema, row, 'api_credentials')
  }

  async #loadChildDefinitions(
    agentIds: readonly string[],
    signal: AbortSignal
  ): Promise<readonly SubAgentToolDefinition[]> {
    if (agentIds.length === 0) return []
    const result = await this.#options.database.query(
      `SELECT agent_id, name, description, system_prompt, llm_config_name,
              sys_tool_ids, available_agent_ids, model_params, metadata, is_active
       FROM core_agents WHERE agent_id = ANY($1::text[]) AND is_active = true`,
      [agentIds],
      signal
    )
    const byId = new Map(
      result.rows.map((row: unknown): readonly [string, CoreAgentRow] => {
        const parsed = parseRow(coreAgentRowSchema, row, 'core_agents child')
        return [parsed.agent_id, parsed]
      })
    )
    const definitions: SubAgentToolDefinition[] = []
    for (const agentId of agentIds) {
      const child = byId.get(agentId)
      if (child === undefined) continue
      definitions.push({
        agentId: child.agent_id,
        name: child.name,
        description: child.description,
        systemPrompt: child.system_prompt,
        systemToolIds: child.sys_tool_ids,
      })
    }
    return definitions
  }
}

function parseModelParams(value: Readonly<Record<string, unknown>>): AgentModelParams {
  return {
    ...numberProperty(value, 'temperature', 'model_params.temperature'),
    ...integerProperty(value, 'max_tokens', 'maxTokens', 'model_params.max_tokens'),
    ...integerProperty(value, 'context_window', 'contextWindow', 'model_params.context_window'),
    ...booleanProperty(value, 'thinking', 'model_params.thinking'),
  }
}

function parseRuntimeConfig(value: Readonly<Record<string, unknown>>): AgentRuntimeConfig {
  const config: AgentRuntimeConfig = {
    ...integerProperty(
      value,
      'max_tool_iterations',
      'maxToolIterations',
      'metadata.max_tool_iterations'
    ),
    ...integerProperty(value, 'max_llm_retries', 'maxLlmRetries', 'metadata.max_llm_retries'),
    ...integerProperty(
      value,
      'llm_retry_backoff_seconds',
      'llmRetryBackoffSeconds',
      'metadata.llm_retry_backoff_seconds'
    ),
    ...integerProperty(
      value,
      'llm_retry_backoff_max_seconds',
      'llmRetryBackoffMaxSeconds',
      'metadata.llm_retry_backoff_max_seconds'
    ),
    ...integerProperty(
      value,
      'llm_timeout_seconds',
      'llmTimeoutSeconds',
      'metadata.llm_timeout_seconds'
    ),
  }
  if (value['compression_enabled'] !== true) return config
  return {
    ...config,
    compression: {
      enabled: true,
      restorer: createRuntimeDefaultRestorer(),
      ...integerProperty(
        value,
        'compression_threshold',
        'triggerThreshold',
        'metadata.compression_threshold'
      ),
      ...integerProperty(
        value,
        'compression_keep_recent',
        'keepRecent',
        'metadata.compression_keep_recent'
      ),
    },
  }
}

function numberProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string
): Readonly<Record<string, number>> {
  const candidate = value[key]
  if (candidate === undefined) return {}
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new Error(`${label} 必须是有限数值`)
  }
  return { temperature: candidate }
}

function integerProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
  outputKey: string,
  label: string
): Readonly<Record<string, number>> {
  const candidate = value[key]
  if (candidate === undefined) return {}
  if (!Number.isSafeInteger(candidate) || Number(candidate) < 0) {
    throw new Error(`${label} 必须是非负安全整数`)
  }
  return { [outputKey]: Number(candidate) }
}

function booleanProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string
): Readonly<Record<string, boolean>> {
  const candidate = value[key]
  if (candidate === undefined) return {}
  if (typeof candidate !== 'boolean') throw new Error(`${label} 必须是布尔值`)
  return { thinking: candidate }
}

function parseRow<TValue>(schema: z.ZodType<TValue>, row: unknown, table: string): TValue {
  const parsed = schema.safeParse(row)
  if (!parsed.success) throw new Error(`${table} 数据无效: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}
