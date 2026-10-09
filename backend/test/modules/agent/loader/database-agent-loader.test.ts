import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LlmAdapter, LlmAdapterFactory, LlmChunk } from 'red-bean-qing-tuan/llm'
import type { Tool, ToolResult, ToolSchema } from 'red-bean-qing-tuan/pipeline'
import type { IdGenerator } from '../../../../src/shared/id/id-generator.js'

import { DbMainAgentLoader } from '../../../../src/modules/agent/loader/adapter/database-agent-loader.js'
import { PreparedAgentLoader } from '../../../../src/modules/agent/loader/service/prepared-agent-loader.js'
import { RuntimeAgentExecutor } from '../../../../src/modules/agent/execution/adapter/runtime-agent-executor.js'
import type {
  AgentLoader,
  AgentRunPreparation,
} from '../../../../src/modules/agent/loader/port/agent-loader.port.js'
import type { SubExecutionRecord } from '../../../../src/modules/agent/subagent/model/sub-execution.js'
import type { SubExecutionRepository } from '../../../../src/modules/agent/subagent/repository/port/sub-execution-repository.port.js'
import { RuntimeSubAgentToolFactory } from '../../../../src/modules/agent/subagent/tool-factory/adapter/runtime-subagent-tool-factory.js'
import { ToolRegistry } from '../../../../src/platform/tool/registry/tool-registry.js'
import type { SqlExecutor, SqlQueryResult } from '../../../../src/infra/database/postgres.js'

const SIGNAL = new AbortController().signal

class StaticDatabase implements SqlExecutor {
  readonly #rows: Readonly<Record<string, readonly unknown[]>>

  public constructor(rows: Readonly<Record<string, readonly unknown[]>>) {
    this.#rows = rows
  }

  public query(sql: string): Promise<SqlQueryResult> {
    const table = Object.keys(this.#rows).find((candidate): boolean =>
      sql.includes(`FROM ${candidate}`)
    )
    const rows = table === undefined ? [] : (this.#rows[table] ?? [])
    return Promise.resolve({ rows, rowCount: rows.length })
  }
}

class StaticIds implements IdGenerator {
  public generate(prefix: string): string {
    return `${prefix}_1`
  }
}

class StaticTool implements Tool {
  public readonly name = 'sys_test'
  public readonly schema: ToolSchema = {
    type: 'function',
    function: { name: this.name, description: 'test', parameters: { type: 'object' } },
  }

  public execute(): Promise<ToolResult> {
    return Promise.resolve({ content: 'ok' })
  }
}

class EmptyAdapter implements LlmAdapter {
  public streamCompletion(): Promise<AsyncIterable<LlmChunk>> {
    return Promise.resolve(stream([]))
  }
}

class EmptySubExecutionRepository implements SubExecutionRepository {
  public create(): Promise<void> {
    return Promise.resolve()
  }

  public getById(): Promise<SubExecutionRecord | undefined> {
    return Promise.resolve(undefined)
  }

  public listPending(): Promise<readonly SubExecutionRecord[]> {
    return Promise.resolve([])
  }

  public listBySession(): Promise<readonly SubExecutionRecord[]> {
    return Promise.resolve([])
  }

  public claimPending(): Promise<SubExecutionRecord> {
    return Promise.reject(new Error('没有待恢复子执行'))
  }

  public claimResume(): Promise<void> {
    return Promise.resolve()
  }

  public renewResumeLease(): Promise<void> {
    return Promise.resolve()
  }

  public appendRecoveryMessage(): Promise<void> {
    return Promise.resolve()
  }

  public update(): Promise<void> {
    return Promise.resolve()
  }
}

function subAgentDependencies(registry: ToolRegistry): {
  readonly subAgentToolFactory: RuntimeSubAgentToolFactory
} {
  const subExecutionRepository = new EmptySubExecutionRepository()
  return {
    subAgentToolFactory: new RuntimeSubAgentToolFactory({
      executor: new RuntimeAgentExecutor(),
      idGenerator: new StaticIds(),
      registry,
      repository: subExecutionRepository,
    }),
  }
}

void describe('database main Agent loader', () => {
  void it('validates rows and builds the configured model, tools, and runtime policy', async () => {
    const calls: string[][] = []
    const adapterFactory: LlmAdapterFactory = (
      provider: string,
      apiKey: string,
      baseUrl: string,
      modelName: string
    ): LlmAdapter => {
      calls.push([provider, apiKey, baseUrl, modelName])
      return new EmptyAdapter()
    }
    const registry = new ToolRegistry([
      {
        name: 'test',
        register(registrar): void {
          registrar.provide(new StaticTool())
        },
      },
    ])
    const loader = new DbMainAgentLoader({
      database: new StaticDatabase({
        core_agents: [
          {
            agent_id: 'default',
            name: '默认助手',
            description: 'description',
            system_prompt: 'system',
            llm_config_name: 'main',
            sys_tool_ids: ['sys_test'],
            available_agent_ids: [],
            model_params: {
              temperature: 0.25,
              max_tokens: 2048,
              context_window: 32_000,
              thinking: true,
            },
            metadata: {
              max_tool_iterations: 12,
              max_llm_retries: 4,
              llm_retry_backoff_seconds: 2,
              llm_retry_backoff_max_seconds: 9,
              llm_timeout_seconds: 40,
            },
            is_active: true,
          },
        ],
        llm_configs: [
          {
            llm_config_id: 'LLMC_1',
            name: 'main',
            provider: 'openai',
            model_name: 'model-x',
            credential_id: 'CRED_1',
          },
        ],
        api_credentials: [
          {
            api_credential_id: 'CRED_1',
            api_base_url: 'https://model.invalid/v1',
            api_key: 'secret',
          },
        ],
      }),
      registry,
      ...subAgentDependencies(registry),
      adapterFactory,
    })

    const config = await loader.load('default', SIGNAL)

    assert.deepEqual(calls, [['openai', 'secret', 'https://model.invalid/v1', 'model-x']])
    assert.equal(config.systemPrompt, 'system')
    assert.deepEqual(config.modelParams, {
      temperature: 0.25,
      maxTokens: 2048,
      contextWindow: 32_000,
      thinking: true,
    })
    assert.deepEqual(config.runtimeConfig, {
      maxToolIterations: 12,
      maxLlmRetries: 4,
      llmRetryBackoffSeconds: 2,
      llmRetryBackoffMaxSeconds: 9,
      llmTimeoutSeconds: 40,
    })
    assert.deepEqual(
      config.tools?.map((tool): string => tool.function.name),
      ['sys_test']
    )
    assert.equal(config.preparation, undefined)
  })

  void it('rejects disabled and malformed Agent rows at the database boundary', async () => {
    const registry = new ToolRegistry([
      {
        name: 'test',
        register(registrar): void {
          registrar.provide(new StaticTool())
        },
      },
    ])
    const base = {
      name: 'default',
      description: '',
      system_prompt: '',
      llm_config_name: 'main',
      sys_tool_ids: [],
      available_agent_ids: [],
      model_params: {},
      metadata: {},
      is_active: true,
    }
    const create = (agent: unknown): DbMainAgentLoader =>
      new DbMainAgentLoader({
        database: new StaticDatabase({ core_agents: [agent] }),
        registry,
        ...subAgentDependencies(registry),
        adapterFactory: (): LlmAdapter => new EmptyAdapter(),
      })

    await assert.rejects(
      create({ ...base, agent_id: 'default', is_active: false }).load('default', SIGNAL),
      /已禁用/u
    )
    await assert.rejects(create({ ...base, agent_id: 42 }).load('default', SIGNAL), /core_agents/u)
  })

  void it('由模块装饰器注入运行准备能力，数据库 Loader 不持有恢复依赖', async () => {
    const preparation: AgentRunPreparation = {
      prepare: (): Promise<void> => Promise.resolve(),
    }
    const source: AgentLoader = {
      load: (): Promise<{ readonly systemPrompt: string }> =>
        Promise.resolve({ systemPrompt: 'system' }),
    }

    const config = await new PreparedAgentLoader(source, preparation).load('default', SIGNAL)

    assert.equal(config.systemPrompt, 'system')
    assert.equal(config.preparation, preparation)
  })
})

async function* stream(chunks: readonly LlmChunk[]): AsyncGenerator<LlmChunk> {
  for (const chunk of chunks) {
    await Promise.resolve()
    yield chunk
  }
}
