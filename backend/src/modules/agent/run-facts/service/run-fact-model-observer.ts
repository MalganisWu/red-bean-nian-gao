import type {
  AgentModelAdapter,
  AgentModelChunk,
  AgentModelRequest,
} from '../../execution/model/agent-execution-contract.js'
import { normalizeError } from '../../../../shared/errors/normalize-error.js'
import type { RunFactRecorder } from './run-fact-recorder.js'

/**
 * 事实日志的 LLM 请求观察 adapter：以装饰器包裹产品模型 Port，把每次
 * `streamCompletion` 观察为一个 attempt（起止、usage、错误）。
 * 只包裹主运行使用的 adapter 实例；子 Agent 委派在 Loader 内部捕获原始 adapter，
 * 因此子执行的内部 LLM 调用不会混入父 run 的事实（ADR：子执行步骤进子执行自己的 run 记录）。
 */
export class RunFactModelObserver implements AgentModelAdapter {
  readonly #recorder: RunFactRecorder
  readonly #inner: AgentModelAdapter

  public constructor(recorder: RunFactRecorder, inner: AgentModelAdapter) {
    this.#recorder = recorder
    this.#inner = inner
  }

  public async streamCompletion(
    request: AgentModelRequest,
    signal: AbortSignal
  ): Promise<AsyncIterable<AgentModelChunk>> {
    this.#recorder.beginModelAttempt()
    let iterable: AsyncIterable<AgentModelChunk>
    try {
      iterable = await this.#inner.streamCompletion(request, signal)
    } catch (cause: unknown) {
      // 连接建立阶段失败：该 attempt 以错误收场，再上抛交给 SDK 的重试循环。
      this.#recorder.markModelAttemptError(normalizeError(cause).message)
      this.#recorder.endModelAttempt()
      throw cause
    }
    return this.#watch(iterable)
  }

  /** 逐 chunk 观察流：首个 usage 计入本 attempt（与 SDK 计数口径一致），错误块只记首个。 */
  async *#watch(iterable: AsyncIterable<AgentModelChunk>): AsyncGenerator<AgentModelChunk> {
    try {
      for await (const chunk of iterable) {
        if (chunk.usage !== undefined) this.#recorder.recordModelUsage(chunk.usage)
        if (chunk.error !== undefined) {
          this.#recorder.markModelAttemptError(chunk.error.message)
        }
        yield chunk
      }
    } catch (cause: unknown) {
      this.#recorder.markModelAttemptError(normalizeError(cause).message)
      throw cause
    } finally {
      // 流结束/被关闭/异常三种路径都要闭合 attempt，避免悬挂到 run 终态才补记。
      this.#recorder.endModelAttempt()
    }
  }
}
