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

/**
 * 收尾阶段的超时上限（30 秒），也是 `finalizationTimeoutMilliseconds` 的缺省值。
 *
 * 收尾跑在独立于客户端信号的一次性超时信号上：会话保存、后台任务投递、事实日志终态化任一步骤
 * 卡死时，都必须在有限时间内放弃，否则一个卡住的 run 会连同其后端资源一起长期滞留。取 30 秒
 * 是因为收尾只做落库与投递、没有外部 LLM 调用，正常远快于此，留出的余量用于吸收数据库抖动。
 */
const FINALIZATION_TIMEOUT_MILLISECONDS = 30_000

/** 服务依赖；`deliveryQueue` / `runFacts` / `logger` 均可缺省，缺省即关闭对应能力。 */
export interface ProductAgentRunServiceOptions {
  /** Agent 配置与执行定义的加载器。 */
  readonly loader: AgentLoader
  /** 统一执行 Port，真正跑 Runtime。 */
  readonly executor: AgentExecutionPort
  /** 会话运行状态服务，负责 lease、checkpoint 与消息恢复。 */
  readonly sessions: SessionRunServicePort
  /** 会话消息缓冲；用于恢复未提交消息。 */
  readonly messageBuffer: MessageBuffer
  /** 后台任务结果投递队列；缺省即不投递。 */
  readonly deliveryQueue?: TaskResultDeliveryPort | undefined
  /**
   * 会话事实日志（session_runs）仓储；缺省时跳过事实写入（部分测试与轻量装配场景）。
   * 默认实现为 `PostgresRunFactRepository`，由 `agent.module.ts` 注入。
   */
  readonly runFacts?: RunFactRepository | undefined
  /** 仅记录服务端诊断信息；不得把 error 字段序列化进 SSE。 */
  readonly logger?: AgentRunLogger | undefined
  /** 收尾阶段超时（毫秒）；缺省为 FINALIZATION_TIMEOUT_MILLISECONDS。 */
  readonly finalizationTimeoutMilliseconds?: number | undefined
}

/** 服务端诊断日志的窄接口；只有 error 一档，因为这里的用途就是记录异常。 */
export interface AgentRunLogger {
  /**
   * 记录一条服务端错误日志；只用于诊断，不得写入 SSE。
   * @param message 日志正文
   * @param fields 结构化上下文字段（如 run_id / session_id）
   */
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
  /** Agent 配置加载器；准备阶段据此收窄出执行配置。 */
  readonly #loader: AgentLoader
  /** 统一执行 Port；执行阶段转入后台调用它跑 Runtime。 */
  readonly #executor: AgentExecutionPort
  /** 会话运行状态服务；负责加载与保存会话状态。 */
  readonly #sessions: SessionRunServicePort
  /** 会话消息缓冲。 */
  readonly #messageBuffer: MessageBuffer
  /** 后台任务结果投递队列；未配置时为 undefined，收尾时跳过投递。 */
  readonly #deliveryQueue: TaskResultDeliveryPort | undefined
  /** 会话事实日志仓储；未配置时为 undefined，跳过事实写入。 */
  readonly #runFacts: RunFactRepository | undefined
  /** 诊断日志器；未配置时为 undefined，静默丢弃诊断。 */
  readonly #logger: AgentRunLogger | undefined
  /** 收尾阶段超时（毫秒）；构造时校验为正整数。 */
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

  /**
   * 准备阶段：建句柄、加载 Agent 配置与会话状态，并同步返回可消费的 SSE 句柄。
   * 实际执行 fire-and-forget 转入 `#execute`，失败一律经句柄从流内传播给消费者——
   * 此时响应头早已发出，抛异常已无接收者。
   *
   * @param request - 本次运行的请求（runId / sessionId / userId 等）
   * @param signal - 客户端中止信号；只约束准备与执行阶段，收尾段改用独立超时信号
   * @returns 承载本轮事件、可立即消费的 SSE 句柄
   */
  public async start(request: AgentRunRequest, signal: AbortSignal): Promise<ChatRunHandle> {
    // 准备阶段：建立本轮事件投影，并加载运行期间保持不变的 Agent 配置。
    const handle = new ManagedChatRunHandle(request.runId, request.sessionId, signal)
    const sections = new SectionCollector()
    // Loader 加载期事件出口：只进展示投影。事实日志由执行期的 ChatRunObserver 观察者接入
    // （子 Agent envelope 属 agent_event，本就不进主 run 事实）。
    function emit(event: AgentStreamEvent): void {
      if (event.type !== 'agent_event') sections.collect(event)
      handle.publish(event)
    }
    const config = executableConfig(
      await this.#loader.load(request.agentId, signal, { eventSink: emit })
    )
    // 事实写入失败只影响审计日志：记录 run 维度上下文，不打断会话主流程。
    const reportFactWriteError = (error: Error): void => {
      this.#logger?.error('session run 事实日志写入失败', {
        error,
        run_id: request.runId,
        session_id: request.sessionId,
      })
    }
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
            onError: reportFactWriteError,
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

  /**
   * 执行阶段：转入后台跑 Runtime，随后在独立超时信号上完成收尾（提交会话、投递任务、终态化事实）。
   * 本方法不抛出——所有失败经 `handle.fail` 从流内传播给消费者。
   *
   * @param config 已收窄的执行配置
   * @param state 会话运行状态（lease、checkpoint、待恢复消息）
   * @param traceId 链路追踪 ID
   * @param sections 展示段落收集器
   * @param handle 本轮 SSE 句柄，承载事件与最终关闭
   * @param facts 事实日志写入器；未装配时为 undefined
   */
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
        // 审批挂起事实：interrupting 工具不发 tool_start/tool_result，只能由宿主在
        // 工具返回 interrupt 信号时自己记（引擎对「审批」一无所知）。
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

/**
 * 读取执行配置里的 provider 名，供 run 事实日志记录来源；缺省时回落为空串。
 * 回落而非 `undefined` 是因为 `session_runs.provider` 是非空列，调用点不必再补默认值。
 *
 * @param config - 已收窄的执行配置
 * @returns provider 标识；配置未声明时为「」
 */
function configProvider(config: ExecutableAgentConfig): string {
  return config.provider ?? ''
}

/**
 * 读取执行配置里的模型名，供 run 事实日志记录本轮所用模型；缺省时回落为空串。
 * 与 provider 同理，空串兜底是为了对接下游非空列，而不是把「未配置」伪装成有效模型名。
 *
 * @param config - 已收窄的执行配置
 * @returns 模型标识；配置未声明时为「」
 */
function configModel(config: ExecutableAgentConfig): string {
  return config.model ?? ''
}

/**
 * 把执行结果映射为事实日志的终态命令（R11）：chat cancel 等用户取消在产品内表现为
 * cancelled 终态，统一归属 cancelled_by='user'；interrupted 对应 Runtime 的 suspended。
 *
 * Outcome 与错误两个入参缺一不可：`suspended` 是等待用户确认的正常中间态，只有同时看到
 * 「completed 且无错误」才判成功，其余组合一律落到 failed 并带上可定位的原因文本——
 * 事实日志是事后排查的唯一依据，不能把不同失败形态压成同一个终态。
 *
 * @param outcome - Runtime 的执行终态；undefined 表示执行前段即失败、根本没拿到 Outcome
 * @param runError - 执行或会话保存阶段累积的错误；用于区分 completed 与 failed
 * @returns 与 run 状态一一对应的终态命令；无匹配分支时兜底为 failed
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
