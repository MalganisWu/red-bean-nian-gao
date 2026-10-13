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
  /** 事实写入器；把每次请求的起止、usage 与错误归到 attempt 上。 */
  readonly #recorder: RunFactRecorder
  /** 被装饰的内层模型 adapter，请求原样透传给它。 */
  readonly #inner: AgentModelAdapter

  public constructor(recorder: RunFactRecorder, inner: AgentModelAdapter) {
    this.#recorder = recorder
    this.#inner = inner
  }

  /**
   * 观察一次 LLM 请求：建 attempt、转发调用，并把连接建立阶段的错误归到本 attempt 后上抛。
   * 只记录不改变语义——失败仍交由 SDK 的重试循环处理。
   *
   * @param request - 主运行的模型请求，原样透传给内层 adapter
   * @param signal - 中止信号，原样透传
   * @returns 内层 adapter 的 chunk 流，经 `#watch` 旁路观察 usage 与错误
   */
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

  /**
   * 逐 chunk 观察流：首个 usage 计入本 attempt（与 SDK 计数口径一致），错误块只记首个。
   *
   * 装饰器必须**完全透明**：`yield chunk` 原样透传，不合并、不改造、不吞异常。
   * 一旦这里改了流的内容或时序，主流程收到的就不再是 adapter 的原始输出，
   * 而观察者本应只是旁观者。
   *
   * @param iterable - 内层 adapter 返回的 chunk 流，逐块透传
   * @returns 原样透传同一批 chunk 的生成器，仅旁路观察 usage 与错误
   */
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
