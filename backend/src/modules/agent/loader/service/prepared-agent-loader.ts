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

  /**
   * 在源 Loader 的配置上附加宿主准备步骤（如恢复策略），把补丁点在交给 Runtime 前即定死。
   * @param agentId 目标 agent 主键
   * @param signal 中止信号，透传给源 Loader
   * @param context 加载上下文，透传给源 Loader
   * @returns 附加了宿主准备步骤的配置快照
   */
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
