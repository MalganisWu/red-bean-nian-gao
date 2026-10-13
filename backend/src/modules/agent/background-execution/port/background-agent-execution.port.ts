import type { DisplayMessage } from '../../presentation/model/display-message.js'
import type { AgentRunIdentity } from '../../run/model/agent-run.js'

/** 后台 Agent 执行命令；调用方无需接触 Runtime SDK 的模型、工具或 Checkpoint 类型。 */
export interface BackgroundAgentExecutionCommand extends AgentRunIdentity {
  /** 本次运行使用的 agent 主键；加载器据此读出配置快照。 */
  readonly agentId: string
  /** 恢复缓冲的键；崩溃后用它在无在线消费者时重新取出断点消息。 */
  readonly recoveryKey: string
  /** 本轮用户输入正文；为空串表示不追加新的 user 消息。 */
  readonly input: string
  /** 追加到主系统提示词之后的片段，用来声明这是无人值守的后台执行。 */
  readonly systemPromptAppendix: string
  /** 需要按名排除的工具清单；后台执行不该拥有交互式工具。 */
  readonly excludedToolNames: readonly string[]
}

/** 后台运行的宿主结果；展示消息已经由 Agent Module 使用统一投影规则构建。 */
interface BackgroundAgentExecutionResultBase {
  /** 运行产出的最终正文，用于回写任务结果。 */
  readonly output: string
  /** 已按统一投影规则构建的展示消息序列，供落库快照使用。 */
  readonly displayMessages: readonly DisplayMessage[]
}

/** 后台执行结果的可辨识联合；失败状态必须携带原因，成功状态不得携带错误。 */
export type BackgroundAgentExecutionResult =
  | (BackgroundAgentExecutionResultBase & { readonly status: 'completed'; readonly error?: never })
  | (BackgroundAgentExecutionResultBase & {
      readonly status: 'suspended' | 'cancelled' | 'exhausted'
      readonly reason: string
      readonly error?: never
    })
  | (BackgroundAgentExecutionResultBase & { readonly status: 'failed'; readonly error: Error })

/**
 * Agent Module 对后台业务公开的单次执行能力。
 * 默认实现为 `DefaultBackgroundAgentExecutionService`，由 `agent.module.ts` 的
 * `createAgentModuleCore()` 组装，再经 `app/composition-root.ts` 注入 Task Module。
 * Agent Module 独占 SDK 配置、事件与恢复消息转换；调用方拥有取消信号，并在业务结果落库后显式清理恢复缓冲。
 */
export interface BackgroundAgentExecutionPort {
  /**
   * 跑一次后台执行：加载配置、按名排除交互式工具、追加系统提示词，跑完并投影结果。
   *
   * @param command - 后台执行命令；承载身份、输入、排除工具名与系统提示词附录。
   * @param signal - 调用方拥有的中止信号，透传给加载器与执行端口。
   * @returns 运行结果；按执行端口状态映射为 completed / suspended / cancelled / exhausted / failed。
   */
  execute(
    command: BackgroundAgentExecutionCommand,
    signal: AbortSignal
  ): Promise<BackgroundAgentExecutionResult>
  /**
   * 清空恢复缓冲；业务结果落库后由调用方显式调用，先 flush 再 clear，两次调用都幂等。
   *
   * @param recoveryKey - 恢复缓冲的键（通常由会话与任务派生）。
   * @param signal - 中止信号，传给 MessageBuffer 的 flush / clear。
   */
  clearRecovery(recoveryKey: string, signal: AbortSignal): Promise<void>
}
