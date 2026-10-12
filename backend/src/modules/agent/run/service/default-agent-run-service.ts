import type {
  AgentExecutionCommand,
  AgentExecutionDefinition,
  AgentExecutionOutcome,
  AgentExecutionPort,
} from '../../execution/port/agent-executor.js'
import { EXECUTION_OUTCOME_STATUSES } from '../../execution/port/agent-executor.js'
import { normalizeError } from '../../../../shared/errors/normalize-error.js'
import type { AgentJsonValue } from '../../model/json-value.js'
import type { AgentInterrupt } from '../../execution/model/agent-execution-contract.js'
import type { AgentRunRequest } from '../model/agent-run.js'
import type { AgentRunServicePort } from '../port/agent-run-service.port.js'
import type { AgentLoader, AgentStreamEvent } from '../../loader/port/agent-loader.port.js'
import type { TaskResultDeliveryPort } from '../../task-result-delivery/port/task-result-delivery.port.js'
import { DisplayMessageCollector } from '../../presentation/service/display-message-collector.js'
import { PresentationInterruptAssembler } from '../../presentation/service/presentation-interrupt-assembler.js'
import { SectionCollector } from '../../presentation/service/section-collector.js'
import { embedSubAgentSections } from '../../subagent/service/subagent-display.js'
import type {
  SessionLoadRequest,
  SessionRunServicePort,
  SessionRunState,
} from '../../session/run/port/session-run-service.port.js'
import type { MessageBuffer } from '../../session/message-buffer/port/message-buffer.port.js'
import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentRuntimeEvent } from '../model/agent-runtime-event.js'
import {
  SESSION_RUN_CANCELLED_BY,
  SESSION_RUN_STATUSES,
  type FinalizeSessionRunCommand,
} from '../../run-facts/model/session-run.js'
import type { RunFactRepository } from '../../run-facts/port/run-fact-repository.port.js'
import { RunFactRecorder } from '../../run-facts/service/run-fact-recorder.js'
import { ApprovalFactToolDispatcher } from '../../run-facts/service/approval-fact-dispatcher.js'
import { ChatRunObserver } from '../../chat/stream/chat-run-observer.js'
import { ManagedChatRunHandle, type ChatRunHandle } from '../../chat/stream/chat-run-handle.js'
import {
  cardEvent,
  executableConfig,
  executionError,
  executionSignal,
  type ExecutableAgentConfig,
} from './agent-run-support.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

const FINALIZATION_TIMEOUT_MILLISECONDS = 30_000

export interface ProductAgentRunServiceOptions {
  readonly loader: AgentLoader
  readonly executor: AgentExecutionPort
  readonly sessions: SessionRunServicePort
  readonly messageBuffer: MessageBuffer
  readonly deliveryQueue?: TaskResultDeliveryPort | undefined
  /**
   * 会话事实日志（session_runs）仓储；缺省时跳过事实写入（部分测试与轻量装配场景）。
   * 默认实现为 `PostgresRunFactRepository`，由 `agent.module.ts` 注入。
   */
  readonly runFacts?: RunFactRepository | undefined
  /** 仅记录服务端诊断信息；不得把 error 字段序列化进 SSE。 */
  readonly logger?: AgentRunLogger | undefined
  readonly finalizationTimeoutMilliseconds?: number | undefined
}

export interface AgentRunLogger {
  error(message: string, fields?: Readonly<Record<string, unknown>>): void
}

/**
 * 组合产品会话生命周期，并把实际 Agent 执行委托给统一执行 Port。
 *
 * 一次 run 分三段，边界就是两个 `await` 密集点：
 * 1. **准备**（`start` 内）：建句柄、加载 Agent 配置、加载会话状态。这一段必须同步做完并返回句柄，
 *    调用方才能拿到 SSE 流开始消费。
 * 2. **执行**（`start` 里 fire-and-forget 的 `#execute`）：转入后台跑 Runtime。
 * 3. **收尾**（`#execute` 尾部）：提交会话、投递积压的后台任务结果、终态化事实日志。
 *
 * 收尾段有一条硬规则：**它跑在独立的超时信号上，不复用客户端信号**。
 * 客户端断开不该让「这次运行已经产生的状态」丢失——那会留下一个永远停在 running 的会话。
 */
export class ProductAgentRunService implements AgentRunServicePort {
  readonly #loader: AgentLoader
  readonly #executor: AgentExecutionPort
  readonly #sessions: SessionRunServicePort
  readonly #messageBuffer: MessageBuffer
  readonly #deliveryQueue: TaskResultDeliveryPort | undefined
  readonly #runFacts: RunFactRepository | undefined
  readonly #logger: AgentRunLogger | undefined
  readonly #finalizationTimeoutMilliseconds: number

  public constructor(options: ProductAgentRunServiceOptions) {
    this.#loader = options.loader
    this.#executor = options.executor
    this.#sessions = options.sessions
    this.#messageBuffer = options.messageBuffer
    this.#deliveryQueue = options.deliveryQueue
    this.#runFacts = options.runFacts
    this.#logger = options.logger
    this.#finalizationTimeoutMilliseconds =
      options.finalizationTimeoutMilliseconds ?? FINALIZATION_TIMEOUT_MILLISECONDS
    if (
      !Number.isSafeInteger(this.#finalizationTimeoutMilliseconds) ||
      this.#finalizationTimeoutMilliseconds <= 0
    ) {
      throw new Error('Session finalization 超时必须是正整数')
    }
  }

  public async start(request: AgentRunRequest, signal: AbortSignal): Promise<ChatRunHandle> {
    // 准备阶段：建立本轮事件投影，并加载运行期间保持不变的 Agent 配置。
    const handle = new ManagedChatRunHandle(request.runId, request.sessionId, signal)
    const sections = new SectionCollector()
    // Loader 加载期事件出口：只进展示投影。事实日志由执行期的 ChatRunObserver 观察者接入
    // （子 Agent envelope 属 agent_event，本就不进主 run 事实）。
    const emit = (event: AgentStreamEvent): void => {
      if (event.type !== 'agent_event') sections.collect(event)
      handle.publish(event)
    }
    const config = executableConfig(
      await this.#loader.load(request.agentId, signal, { eventSink: emit })
    )
    // 事实日志写入器按 run 创建，随 run 生命周期终结（R7）。
    const facts =
      this.#runFacts === undefined
        ? undefined
        : new RunFactRecorder({
            run: {
              runId: request.runId,
              sessionId: request.sessionId,
              userId: request.userId,
              provider: configProvider(config),
              model: configModel(config),
              contextWindow: config.modelParams.contextWindow ?? null,
              startedAt: Date.now(),
            },
            signal,
            repository: this.#runFacts,
            onError: (error): void => {
              this.#logger?.error('session run 事实日志写入失败', {
                error,
                run_id: request.runId,
                session_id: request.sessionId,
              })
            },
          })
    // 会话阶段：在 Runtime 启动前取得 lease、恢复 checkpoint 与未提交消息。
    const loadRequest: SessionLoadRequest = {
      sessionId: request.sessionId,
      checkpointId: request.sessionId,
      userId: request.userId,
      runId: request.runId,
      traceId: request.traceId,
      messages: request.messages,
      ...optionalField('answer', request.answer),
    }
    const state = await this.#sessions.load(loadRequest, signal)
    // 执行阶段转入后台，使 Controller 可以立即开始消费 SSE；最终完成由队列关闭表示。
    // 刻意不 await、也不 catch：失败一律经由 `handle.fail` 从流内部传播给消费者，
    // 因为此时 HTTP 响应头早已发出，抛异常已经没有接收者了。
    void this.#execute(config, state, request.traceId, sections, handle, facts)
    return handle
  }

  async #execute(
    config: ExecutableAgentConfig,
    state: SessionRunState,
    traceId: string,
    sections: SectionCollector,
    handle: ManagedChatRunHandle,
    facts: RunFactRecorder | undefined
  ): Promise<void> {
    const signal = handle.signal
    const display = new DisplayMessageCollector({
      buildSections: (): AgentJsonValue => sections.build(),
    })
    const observer = new ChatRunObserver({
      checkpointId: state.checkpointId,
      generation: {
        revision: state.checkpointRevision,
        ...optionalField('writeProof', state.bufferWriteProof),
      },
      sections,
      display,
      queue: { push: (event): void => handle.publish(event) },
      messageBuffer: this.#messageBuffer,
      ...(facts === undefined
        ? {}
        : {
            onMessage: (message: AgentMessage): void => facts.onMessage(message),
            onEvent: (event: AgentRuntimeEvent): void => facts.publish(event),
          }),
    })
    let runError: Error | undefined
    let outcome: AgentExecutionOutcome | undefined
    try {
      // run 容器先落库（尽力语义）；失败由 recorder 上报，不阻塞执行。
      await facts?.start(signal)
      // Runtime 阶段：复用统一执行 Port，并由观察器同时收集恢复消息与展示事件。
      await config.preparation?.prepare(state.sessionId, signal)
      const definition: AgentExecutionDefinition = {
        // 事实日志的模型观察 adapter 只包主运行：子 Agent 经 Loader 捕获原始 adapter。
        model: facts === undefined ? config.llmAdapter : facts.observeModel(config.llmAdapter),
        /* 审批挂起事实：interrupting 工具不发 tool_start/tool_result，只能由宿主在
           工具返回 interrupt 信号时自己记（引擎对「审批」一无所知）。 */
        dispatcher:
          facts === undefined
            ? config.toolDispatcher
            : new ApprovalFactToolDispatcher(config.toolDispatcher, facts),
        tools: config.tools,
        systemPrompt: config.systemPrompt,
        modelParams: config.modelParams,
        runtimeConfig: config.runtimeConfig,
      }
      const executionCommand: AgentExecutionCommand = {
        kind: state.resume === undefined ? 'run' : 'resume',
        runId: state.runId,
        sessionId: state.sessionId,
        userId: state.userId,
        traceId,
        definition,
        ...optionalField('state', state.runtimeState),
        recoveryMessages: state.recoveryMessages,
        messages: state.messages,
        ...(state.resume === undefined
          ? {}
          : { interruptId: state.resume.interruptId, response: state.resume.response }),
        eventSink: observer,
        messageObserver: observer,
      }
      outcome = await this.#executor.execute(
        executionCommand,
        executionSignal(signal, state.leaseLost)
      )
      runError = executionError(outcome)
      if (outcome.status === 'suspended') {
        const interrupt: AgentInterrupt = {
          toolCallId: outcome.interrupt.id,
          toolName: outcome.interrupt.toolName,
          arguments: outcome.interrupt.arguments,
          payload: {},
        }
        new PresentationInterruptAssembler(display, {
          buildSections: (): AgentJsonValue => sections.build(),
        }).assembleInterrupt(interrupt)
        handle.publish(cardEvent(interrupt))
      }
    } catch (cause: unknown) {
      runError = normalizeError(cause)
    }

    const displayMessages =
      config.subAgentDisplayRegistry === undefined
        ? display.messages
        : embedSubAgentSections(display.messages, config.subAgentDisplayRegistry.data())
    // 收尾用独立超时信号而非 signal：客户端断线不代表这次运行白跑，已产生的状态必须落盘。
    const finalizationSignal = AbortSignal.timeout(this.#finalizationTimeoutMilliseconds)
    try {
      // 收尾阶段独立于客户端信号：先提交 Session，再投递已经完成的后台任务结果。
      // 顺序有依赖：投递队列里那些任务的结果要靠刚提交的会话状态才能被前端读到。
      await this.#sessions.save(
        state,
        {
          ...(outcome === undefined ? {} : { runtimeState: outcome.state }),
          displayMessages,
          ...optionalField('executionError', runError),
          ...(outcome?.interrupt === undefined ? {} : { interruptCallId: outcome.interrupt.id }),
        },
        finalizationSignal
      )
    } catch (cause: unknown) {
      const saveError = normalizeError(cause)
      runError =
        runError === undefined
          ? saveError
          : new AggregateError([runError, saveError], 'Agent 执行与 session 保存均失败')
    }

    // 挂起结果不投递：这一轮还没结束，等用户确认后恢复时再送。
    if (runError === undefined && outcome?.status !== 'suspended') {
      try {
        await this.#deliveryQueue?.drain(state.sessionId, finalizationSignal)
      } catch {
        // Session 已成功提交；后台 reconciler 会重试投递，不能把本轮 Chat 误报为失败。
      }
    }

    // 事实日志终态化独立于收尾顺序：即使 session 保存失败，run 终态仍必须可查。
    if (facts !== undefined) {
      await facts.finalize(finalizeCommand(outcome, runError), finalizationSignal)
    }

    // 走到这里说明三段都跑完了，接下来只有两种收束方式，都必须显式关闭句柄——
    // 句柄不关闭，等待它的 SSE 消费者会一直挂着。
    if (runError !== undefined) {
      this.#logger?.error('agent run failed', {
        error: runError,
        run_id: state.runId,
        session_id: state.sessionId,
        trace_id: traceId,
      })
      handle.fail(runError)
      return
    }
    handle.publish({
      type: 'done',
      tokensUsed: outcome?.tokensUsed ?? 0,
      sessionId: state.sessionId,
    })
    handle.complete()
  }
}

function configProvider(config: ExecutableAgentConfig): string {
  return config.provider ?? ''
}

function configModel(config: ExecutableAgentConfig): string {
  return config.model ?? ''
}

/**
 * 把执行结果映射为事实日志的终态命令（R11）：chat cancel 等用户取消在产品内表现为
 * cancelled 终态，统一归属 cancelled_by='user'；interrupted 对应 Runtime 的 suspended。
 */
function finalizeCommand(
  outcome: AgentExecutionOutcome | undefined,
  runError: Error | undefined
): FinalizeSessionRunCommand {
  const endedAt = Date.now()
  if (outcome !== undefined && outcome.status === EXECUTION_OUTCOME_STATUSES.CANCELLED) {
    return {
      status: SESSION_RUN_STATUSES.CANCELLED,
      endedAt,
      cancelledAt: endedAt,
      cancelledBy: SESSION_RUN_CANCELLED_BY.USER,
    }
  }
  if (outcome !== undefined && outcome.status === EXECUTION_OUTCOME_STATUSES.EXHAUSTED) {
    return { status: SESSION_RUN_STATUSES.EXHAUSTED, endedAt }
  }
  if (outcome !== undefined && outcome.status === EXECUTION_OUTCOME_STATUSES.SUSPENDED) {
    return { status: SESSION_RUN_STATUSES.INTERRUPTED, endedAt }
  }
  if (
    outcome !== undefined &&
    outcome.status === EXECUTION_OUTCOME_STATUSES.COMPLETED &&
    runError === undefined
  ) {
    return { status: SESSION_RUN_STATUSES.COMPLETED, endedAt }
  }
  return {
    status: SESSION_RUN_STATUSES.FAILED,
    endedAt,
    error: runError?.message ?? 'Agent 执行失败',
  }
}
