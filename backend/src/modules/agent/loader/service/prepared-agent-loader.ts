import type {
  AgentBuildConfig,
  AgentLoadContext,
  AgentLoader,
  AgentRunPreparation,
} from '../port/agent-loader.port.js'

/**
 * 为已加载的 Agent 配置附加宿主运行准备步骤。
 * 数据库 Loader 只读取定义；恢复策略由 `agent.module.ts` 显式选择并注入。
 */
export class PreparedAgentLoader implements AgentLoader {
  readonly #source: AgentLoader
  readonly #preparation: AgentRunPreparation

  public constructor(source: AgentLoader, preparation: AgentRunPreparation) {
    this.#source = source
    this.#preparation = preparation
  }

  public async load(
    agentId: string,
    signal: AbortSignal,
    context?: AgentLoadContext
  ): Promise<AgentBuildConfig> {
    return {
      ...(await this.#source.load(agentId, signal, context)),
      preparation: this.#preparation,
    }
  }
}
