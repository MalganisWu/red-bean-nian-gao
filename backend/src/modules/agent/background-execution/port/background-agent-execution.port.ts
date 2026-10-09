import type { DisplayMessage } from '../../presentation/model/display-message.js'
import type { AgentRunIdentity } from '../../run/model/agent-run.js'

/** 后台 Agent 执行命令；调用方无需接触 Runtime SDK 的模型、工具或 Checkpoint 类型。 */
export interface BackgroundAgentExecutionCommand extends AgentRunIdentity {
  readonly agentId: string
  readonly recoveryKey: string
  readonly input: string
  readonly systemPromptAppendix: string
  readonly excludedToolNames: readonly string[]
}

/** 后台运行的宿主结果；展示消息已经由 Agent Module 使用统一投影规则构建。 */
interface BackgroundAgentExecutionResultBase {
  readonly output: string
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
  execute(
    command: BackgroundAgentExecutionCommand,
    signal: AbortSignal
  ): Promise<BackgroundAgentExecutionResult>
  clearRecovery(recoveryKey: string, signal: AbortSignal): Promise<void>
}
