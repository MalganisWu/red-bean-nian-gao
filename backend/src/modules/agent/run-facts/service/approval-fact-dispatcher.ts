import type { AgentToolCall } from '../../model/agent-message.js'
import type { AgentJsonObject } from '../../model/json-value.js'
import type {
  AgentToolCallContext,
  AgentToolDispatcher,
  AgentToolResult,
} from '../../execution/model/agent-execution-contract.js'
import type { RunFactRecorder } from './run-fact-recorder.js'

/**
 * 审批挂起事实的写入装饰器。
 *
 * interrupting 工具在 Runtime 里被当作**屏障**：不发 `tool_start`、不发 `tool_result`，
 * resume 时也不重新 dispatch（只注入一条 tool 消息）。因此宿主若不自己记，
 * 这次调用在轨迹里完全不存在——而「这一步要求过审批」恰恰是最需要留痕的动作。
 *
 * 职责边界：
 * - 本装饰器**只写挂起**；闭合由 `RunFactRecorder.onMessage` 处理 resume 注入的 tool 消息，
 *   投影期按 `callId` 把两条 append-only 记录重建为一行（`waitMs = 闭合.at − 挂起.at`）。
 * - **产品语义不下沉引擎**：引擎对「审批」一无所知，装饰器由产品在组装执行定义时包上
 *   （见 `default-agent-run-service.ts` 与后台执行服务），引擎侧不新增任何事件类型。
 *
 * 记录是尽力语义：`RunFactRecorder` 内部串行队列已保证失败只上报诊断、不影响主流程。
 */
export class ApprovalFactToolDispatcher implements AgentToolDispatcher {
  readonly #next: AgentToolDispatcher
  readonly #recorder: RunFactRecorder
  readonly #now: () => number

  /**
   * @param next 被装饰的 dispatcher（通常是 Runtime 观测包装后的实现）
   * @param recorder 本次运行的事实写入器；只写挂起事实，不参与其余采集
   * @param now 可替换时钟（测试注入固定时刻）
   */
  public constructor(
    next: AgentToolDispatcher,
    recorder: RunFactRecorder,
    now: () => number = Date.now
  ) {
    this.#next = next
    this.#recorder = recorder
    this.#now = now
  }

  /**
   * 转发一次工具分派；工具返回 `signal(kind='interrupt')` 时补一条挂起事实。
   *
   * 挂起判定用**返回的信号**而不是工具名或 schema 的 `interrupting` 标记：
   * 信号是「本次调用确实挂起了」的事实，而标记只是静态声明（声明了也可能不挂起）。
   */
  public async dispatch(
    call: AgentToolCall,
    context: AgentToolCallContext,
    signal: AbortSignal
  ): Promise<AgentToolResult> {
    const startedAt = this.#now()
    const result = await this.#next.dispatch(call, context, signal)
    if (result.signal?.kind === 'interrupt') {
      this.#recorder.recordApprovalPending({
        callId: context.callId,
        name: call.function.name,
        params: parseToolArguments(call.function.arguments),
        startedAt,
      })
    }
    return result
  }
}

/**
 * 工具参数是 wire 上的 JSON 字符串；此处只用于展示投影，解析失败按「无参数」处理，
 * 绝不因为参数格式问题影响工具调用本身。
 */
function parseToolArguments(raw: string): AgentJsonObject | null {
  if (raw.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isJsonObject(value: unknown): value is AgentJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
