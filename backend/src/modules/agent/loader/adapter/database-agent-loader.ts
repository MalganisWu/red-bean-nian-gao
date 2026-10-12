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

/**
 * 从产品数据表加载一次运行所需的不可变配置快照。
 *
 * 「快照」是关键词：`load` 把 agent 行、LLM 配置、凭据、子 Agent 定义和工具目录一次性读出来，
 * 组装成一个自洽的 `AgentBuildConfig` 交给 Runtime。运行期间不再回查数据库，
 * 因此在流式运行中途改配置不会影响正在跑的这一次——这正是产品所说的「能力图在启动期定死」。
 */
export class DbMainAgentLoader implements ChildRuntimeDecoratableAgentLoader {
  readonly #options: DbMainAgentLoaderOptions

  public constructor(options: DbMainAgentLoaderOptions) {
    this.#options = options
  }

  /**
   * 返回一个**新的** loader，只把子运行装饰器换掉。
   * 不可变而非就地改写：同一个 loader 实例可能被并发用于多次加载，
   * 就地改 `subAgentToolFactory` 会让先启动的运行也被后来者的装饰器影响。
   */
  public withChildRuntimeDecorator(decorator: ChildRuntimeDecorator): AgentLoader {
    return new DbMainAgentLoader({
      ...this.#options,
      subAgentToolFactory: this.#options.subAgentToolFactory.withRuntimeDecorator(decorator),
    })
  }

  /**
   * 组装一次运行的完整配置。步骤按依赖方向串行，每一步都可能是「配置不存在」或「数据不合法」的失败点：
   * agent 行 → LLM 配置 → 凭据 → Adapter → 参数 → 子 Agent 定义 → 工具工厂 → 工具目录。
   * `is_active` 的检查放在最前：一个被禁用的 agent 不该走到读凭据那一步。
   */
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

  /**
   * 批量读取可委派的子 Agent 定义。
   *
   * 两个刻意的行为：
   * - **按 `agentIds` 的顺序重建结果**，而不是用查询返回的顺序。Map 的插入顺序来自数据库，
   *   不保证与配置里 `available_agent_ids` 的书写顺序一致，而这个顺序决定了工具清单的排列，
   *   会影响提示词前缀的稳定性（进而影响缓存命中）。
   * - 查不到的 agent **静默跳过**而不是报错。`is_active = true` 的过滤意味着被禁用的子 Agent
   *   会直接消失；父 Agent 因此少一个可委派对象，但它自己仍然能跑——
   *   这与「主 agent 被禁用就直接失败」是有意区分的两种强度。
   */
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

/**
 * 把 `metadata` JSON 解析成运行参数；压缩只有显式 `compression_enabled: true` 才启用。
 *
 * 默认关闭是刻意的：压缩会改写上下文并产生额外的模型调用，是一项有代价的优化，
 * 不该因为某个字段缺失就被悄悄打开。启用时才构造 restorer——不启用就完全不引入这依赖。
 */
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

/**
 * 数据库行进入领域层的唯一入口：逐字段 Zod 校验，失败即抛。
 * 解析失败会把完整的 Zod 报错带进消息——被拒的是不可信数据，排障时需要知道具体哪个字段、
 * 期望什么类型，而不是一句「数据无效」。
 */
function parseRow<TValue>(schema: z.ZodType<TValue>, row: unknown, table: string): TValue {
  const parsed = schema.safeParse(row)
  if (!parsed.success) throw new Error(`${table} 数据无效: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}
