import type { IdGenerator } from '../../../../shared/id/id-generator.js'
import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentRunIdentity } from '../../run/model/agent-run.js'
import type {
  AgentExecutionCommand,
  AgentExecutionDefinition,
  AgentExecutionOutcome,
  AgentExecutionPort,
} from '../../execution/port/agent-executor.js'
import { normalizeError } from '../../../../shared/errors/normalize-error.js'
import {
  type AgentChildRunner,
  type AgentChildRunRequest,
  type AgentChildRunResult,
  type AgentModelAdapter,
  type AgentModelParams,
  type AgentRuntimeConfig,
  type AgentToolDispatcher,
  type AgentToolSchema,
} from '../../execution/model/agent-execution-contract.js'
import { createRuntimeChildRunError } from '../../execution/adapter/runtime-tool-adapter.js'
import type {
  ChildExecutionIdentity,
  ChildExecutionLifecycle,
  ChildSectionCollector,
} from '../run/port/child-execution-lifecycle.port.js'
import {
  ChildExecutionObserver,
  type ChildMessageSink,
  type ChildStreamFactory,
} from './child-execution-observer.js'

/**
 * 子运行的状态取值；与 Runtime 契约 `AgentChildRunResult['status']` 同域。
 * switch 分支必须引用这里的成员而非字符串字面量，避免与父运行状态域混用同一字面量。
 */
const CHILD_RUN_STATUSES = Object.freeze({
  COMPLETED: 'completed',
  SUSPENDED: 'suspended',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXHAUSTED: 'exhausted',
} as const)
/** 子运行的状态联合；直接取自 Runtime 契约，本模块不另立同义状态。 */
type ChildRunStatus = AgentChildRunResult['status']

/** 子运行执行器的依赖；除 `executor`/`adapter`/`dispatcher` 外均可缺省，缺省即关闭对应能力。 */
export interface RuntimeChildRunnerOptions {
  /** 执行器；与主运行共用同一条执行链路，子运行只是换定义与身份。 */
  readonly executor: AgentExecutionPort
  /** 新建子执行时的 ID 前缀；缺省用 `SAEX`，仅影响可读性。 */
  readonly executionPrefix?: string | undefined
  /** ID 生成器；新建子执行且未带 executionId 时必须有，否则直接报错。 */
  readonly idGenerator?: IdGenerator | undefined
  /** 模型适配器；作为子运行执行定义的一部分。 */
  readonly adapter: AgentModelAdapter
  /** 可暴露给子 Agent 的工具 schema；缺省表示不给任何工具。 */
  readonly tools?: readonly AgentToolSchema[] | undefined
  /** 工具分发器；执行子 Agent 的工具调用。 */
  readonly dispatcher: AgentToolDispatcher
  /** 子 Agent 系统提示词；缺省为空串。 */
  readonly systemPrompt?: string | undefined
  /** 模型参数；缺省为空对象。 */
  readonly modelParams?: AgentModelParams | undefined
  /** 运行时配置；缺省为空对象。 */
  readonly runtimeConfig?: AgentRuntimeConfig | undefined
  /** 增量消息落库回调；缺省表示不持久化中间消息。 */
  readonly onMessage?: ChildMessageSink | undefined
  /** 子执行生命周期；缺省表示不做持久化加载与保存。 */
  readonly lifecycle?: ChildExecutionLifecycle | undefined
  /** 展示收集器工厂；缺省表示不收集展示 section。 */
  readonly createSectionCollector?: (() => ChildSectionCollector) | undefined
  /** 子运行事件出口工厂；缺省表示不向父流转发子执行进展。 */
  readonly stream?: ChildStreamFactory | undefined
}

/**
 * 运行 Runtime 子 Agent 的产品 adapter，业务生命周期只接收业务自有 DTO。
 *
 * 与主运行共用同一个 `AgentExecutionPort`——子 Agent 不是另一条执行链路，
 * 只是「换一份定义、换一个 run 身份」再跑一次同样的执行流程。
 * 子执行的 runId 就是它的 `executionId`，父请求 ID 降级为 `parentRunId` 保留在事实里
 * （见 `childRunIdentity`），这样子执行的事实能独立成篇，又能被父运行关联到。
 */
export class RuntimeChildRunner implements AgentChildRunner {
  /** 构造时固定的依赖集合；运行器自身无状态，每次 runChild 独立组装。 */
  readonly #options: RuntimeChildRunnerOptions

  public constructor(options: RuntimeChildRunnerOptions) {
    this.#options = options
  }

  /**
   * 跑一次子运行。三段结构与主运行一致：装载持久状态 → 执行 → 在 `finally` 中保存。
   *
   * 保存放在 `finally` 是必要的：子运行失败或挂起时同样要留下执行记录，
   * 否则父 Agent 拿到的 `executionId` 指向一条不存在的记录，无法续跑也无从排障。
   * 保存用独立的 30s 超时信号——父运行的取消不该让这条记录丢失。
   *
   * @param request - 父 Agent 的委派请求；executionId 空串表示新建，非空且带 resume 表示续跑
   * @param signal - 父运行的中止信号；与持久租约信号合流后驱动执行（租约丢失即取消）
   * @returns 子运行结果；被取消时返回 cancelled 结果，其余执行错误抛出，正常路径按 outcome 状态返回
   */
  public async runChild(
    request: AgentChildRunRequest,
    signal: AbortSignal
  ): Promise<AgentChildRunResult> {
    const executionId = this.executionId(request)
    // 恢复要求两者同时具备：知道「续哪次执行」以及「回答哪个中断」。只给一个都是调用方搞错了。
    const isResume = request.executionId !== '' && request.resume !== undefined
    const messages: readonly AgentMessage[] = isResume
      ? []
      : [{ role: 'user', content: buildDelegationUserMessage(request) }]
    const identity: ChildExecutionIdentity = {
      executionId,
      sessionId: request.threadId,
      requestId: request.requestId,
      userId: request.userId,
      agentId: request.agentId,
      parentCallId: request.parentCallId,
      messages,
      ...(request.resume === undefined ? {} : { interruptId: request.resume.interruptId }),
    }
    const sectionCollector = this.#options.createSectionCollector?.()
    const forwardedEventSink = this.#options.stream?.(
      executionId,
      request.parentCallId,
      request.eventSink
    )
    const persisted = await this.#options.lifecycle?.load(identity, isResume, signal)
    const observer = new ChildExecutionObserver(
      executionId,
      persisted?.persistenceRevision ?? 0n,
      sectionCollector,
      forwardedEventSink,
      this.#options.onMessage
    )
    let outcome: AgentExecutionOutcome | undefined
    let executionError: Error | undefined
    try {
      const definition: AgentExecutionDefinition = {
        model: this.#options.adapter,
        dispatcher: this.#options.dispatcher,
        tools: this.#options.tools ?? [],
        systemPrompt: this.#options.systemPrompt ?? '',
        modelParams: this.#options.modelParams ?? {},
        runtimeConfig: this.#options.runtimeConfig ?? {},
      }
      const executionCommand: AgentExecutionCommand = {
        kind: isResume ? 'resume' : 'run',
        ...childRunIdentity(identity, request.traceId),
        definition,
        ...(persisted?.state === undefined ? {} : { state: persisted.state }),
        ...(persisted?.recoveryMessages === undefined
          ? {}
          : { recoveryMessages: persisted.recoveryMessages }),
        ...(isResume
          ? {
              interruptId: request.resume?.interruptId ?? '',
              response: request.resume?.response ?? '',
            }
          : { messages: identity.messages }),
        ...(sectionCollector === undefined && forwardedEventSink === undefined
          ? {}
          : { eventSink: observer }),
        ...(this.#options.onMessage === undefined ? {} : { messageObserver: observer }),
      }
      // 子执行的租约丢失同样表现为取消：另一实例已接管这个子执行，继续跑只会写一份被覆盖的状态。
      const executionSignal =
        persisted?.lease === undefined ? signal : AbortSignal.any([signal, persisted.lease.signal])
      outcome = await this.#options.executor.execute(executionCommand, executionSignal)
      // 把失败转成异常，让下面统一的 catch 处理；否则每条状态分支都要重复一遍错误逻辑。
      if (outcome.error !== undefined) throw outcome.error
    } catch (cause: unknown) {
      executionError = normalizeError(cause)
    } finally {
      await this.#options.lifecycle?.save(
        identity,
        outcome,
        sectionCollector?.build(),
        executionError,
        persisted?.persistenceRevision,
        persisted?.lease,
        AbortSignal.timeout(30_000)
      )
    }

    if (executionError !== undefined) {
      if (outcome?.status === CHILD_RUN_STATUSES.CANCELLED || signal.aborted) {
        return failedResult(CHILD_RUN_STATUSES.CANCELLED, executionId, '子 Agent 被取消', outcome)
      }
      throw createRuntimeChildRunError(
        executionError.message,
        {
          status: CHILD_RUN_STATUSES.FAILED,
          executionId,
          ...partialOutput(outcome),
        },
        executionError
      )
    }

    switch (outcome?.status) {
      case CHILD_RUN_STATUSES.SUSPENDED: {
        const interrupt = outcome.interrupt
        return {
          status: CHILD_RUN_STATUSES.SUSPENDED,
          executionId,
          ...(interrupt === undefined
            ? {}
            : {
                interrupt: {
                  toolCallId: interrupt.id,
                  toolName: interrupt.toolName,
                  arguments: interrupt.arguments,
                  payload: {},
                },
              }),
        }
      }
      case CHILD_RUN_STATUSES.CANCELLED:
        return failedResult(
          CHILD_RUN_STATUSES.CANCELLED,
          executionId,
          delegationFailureReason(CHILD_RUN_STATUSES.CANCELLED),
          outcome
        )
      case CHILD_RUN_STATUSES.EXHAUSTED:
        return failedResult(
          CHILD_RUN_STATUSES.EXHAUSTED,
          executionId,
          delegationFailureReason(CHILD_RUN_STATUSES.EXHAUSTED),
          outcome
        )
      case CHILD_RUN_STATUSES.FAILED:
        return failedResult(
          CHILD_RUN_STATUSES.FAILED,
          executionId,
          delegationFailureReason(CHILD_RUN_STATUSES.FAILED),
          outcome
        )
      case CHILD_RUN_STATUSES.COMPLETED:
      case undefined:
        break
    }

    const output = lastAssistantContent(outcome?.messages ?? [])
    if (output === '') {
      return {
        status: CHILD_RUN_STATUSES.FAILED,
        executionId,
        error: '子 Agent 执行完成，但未产生有效输出',
      }
    }
    return { status: CHILD_RUN_STATUSES.COMPLETED, executionId, output }
  }

  /**
   * 决定本次子执行的 id：请求带了就复用（续跑），否则用生成器新建。
   *
   * @param request - 父 Agent 的委派请求；非空 executionId 表示续跑，直接沿用。
   * @returns 本次子执行的标识。
   */
  private executionId(request: AgentChildRunRequest): string {
    if (request.executionId !== '') return request.executionId
    if (this.#options.idGenerator === undefined) {
      const result: AgentChildRunResult = { status: CHILD_RUN_STATUSES.FAILED }
      throw createRuntimeChildRunError('delegation ID generator must not be nil', result)
    }
    return this.#options.idGenerator.generate(this.#options.executionPrefix ?? 'SAEX')
  }
}

/**
 * 子执行 ID 是子 Agent 自身 run ID，父请求 ID 只通过 parentRunId 保留。
 * 这样父子两次运行各自成篇、可独立排障，父运行又能顺着 parentRunId 关联到子执行。
 *
 * @param identity - 子执行身份；其 executionId 直接作为 runId。
 * @param traceId - 父运行透传的链路标识，用于把父子执行串在同一 trace 下。
 * @returns Runtime 运行身份。
 */
function childRunIdentity(identity: ChildExecutionIdentity, traceId: string): AgentRunIdentity {
  return {
    runId: identity.executionId,
    sessionId: identity.sessionId,
    userId: identity.userId,
    traceId,
    parentRunId: identity.requestId,
  }
}

/**
 * 把父 Agent 的委派请求拼成子运行的首条 user 消息。
 * 续跑只回一句「继续完成任务」（首轮指令已在历史里），新建才拼接上下文与期望格式，
 * 避免续跑时把整段指令重复喂给模型。
 *
 * @param request - 父 Agent 的委派请求。
 * @returns 子运行的首条用户消息文本。
 */
function buildDelegationUserMessage(request: AgentChildRunRequest): string {
  if (request.executionId !== '') {
    return request.instruction !== '' ? request.instruction : '请继续完成任务。'
  }
  let message = request.instruction
  if (request.context !== '') message += `\n上下文信息：${request.context}`
  if (request.expectedFormat !== '') message += `\n期望返回格式：${request.expectedFormat}`
  return message
}

/**
 * 组装失败/取消类的子运行结果，并把已有部分输出一并带上。
 * `partialOutput` 只在确有正文时出现，让父 Agent 能拿到半成品，而不是只收到一个错误码。
 *
 * @param status - 失败结局（cancelled / failed / exhausted）。
 * @param executionId - 子执行 id，父运行据此续跑或排障。
 * @param reason - 面向父 Agent 的失败原因文案。
 * @param outcome - Runtime 的执行结果，用于提取部分输出；未执行时为 undefined。
 * @returns 子运行结果。
 */
function failedResult(
  status: ChildRunStatus,
  executionId: string,
  reason: string,
  outcome: AgentExecutionOutcome | undefined
): AgentChildRunResult {
  return { status, executionId, error: reason, ...partialOutput(outcome) }
}

/**
 * 提取执行结果里已有的助手正文作为 `partialOutput`；没有正文时返回空对象，
 * 让这个可选字段在上层按「有则带、无则省」处理，不产生 value 为 undefined 的字段。
 *
 * @param outcome - Runtime 的执行结果；为 undefined 时视为无输出。
 * @returns 含 `partialOutput` 的对象；无正文时为空对象。
 */
function partialOutput(outcome: AgentExecutionOutcome | undefined): {
  readonly partialOutput?: string | undefined
} {
  const output = lastAssistantContent(outcome?.messages ?? [])
  return output === '' ? {} : { partialOutput: output }
}

/**
 * 把子运行状态翻译成面向父 Agent 的中文失败原因。
 * 各终态给不同措辞，让父 Agent 与排障者能区分「被取消」「LLM 失败」「耗尽迭代」这些失败机理。
 *
 * @param status - 子运行的失败结局。
 * @returns 对应的中文失败原因。
 */
function delegationFailureReason(status: ChildRunStatus): string {
  switch (status) {
    case CHILD_RUN_STATUSES.CANCELLED:
      return '子 Agent 被取消'
    case CHILD_RUN_STATUSES.FAILED:
      return '子 Agent LLM 调用失败'
    case CHILD_RUN_STATUSES.EXHAUSTED:
      return '子 Agent 达到最大工具迭代次数，任务未完成'
    case CHILD_RUN_STATUSES.COMPLETED:
    case CHILD_RUN_STATUSES.SUSPENDED:
      return '子 Agent 执行失败'
  }
}

/**
 * 取最后一条有正文的 assistant 消息；末条可能是工具轮次（content 为 null）或工具结果。
 * 倒着找第一条有正文的助手消息，作为子运行的最终输出。
 *
 * @param messages - 子运行的完整消息历史。
 * @returns 最后一条有正文的助手内容；找不到时返回空串。
 */
function lastAssistantContent(messages: readonly AgentMessage[]): string {
  for (const message of messages.toReversed()) {
    if (message.role === 'assistant' && message.content !== null && message.content !== '') {
      return message.content
    }
  }
  return ''
}
