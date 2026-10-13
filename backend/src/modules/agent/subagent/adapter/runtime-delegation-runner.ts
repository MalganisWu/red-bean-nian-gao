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

const CHILD_RUN_STATUSES = Object.freeze({
  COMPLETED: 'completed',
  SUSPENDED: 'suspended',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXHAUSTED: 'exhausted',
} as const)
type ChildRunStatus = AgentChildRunResult['status']

/** 子运行执行器的依赖；除 `executor`/`adapter`/`dispatcher` 外均可缺省，缺省即关闭对应能力。 */
export interface RuntimeChildRunnerOptions {
  readonly executor: AgentExecutionPort
  readonly executionPrefix?: string | undefined
  readonly idGenerator?: IdGenerator | undefined
  readonly adapter: AgentModelAdapter
  readonly tools?: readonly AgentToolSchema[] | undefined
  readonly dispatcher: AgentToolDispatcher
  readonly systemPrompt?: string | undefined
  readonly modelParams?: AgentModelParams | undefined
  readonly runtimeConfig?: AgentRuntimeConfig | undefined
  readonly onMessage?: ChildMessageSink | undefined
  readonly lifecycle?: ChildExecutionLifecycle | undefined
  readonly createSectionCollector?: (() => ChildSectionCollector) | undefined
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

  private executionId(request: AgentChildRunRequest): string {
    if (request.executionId !== '') return request.executionId
    if (this.#options.idGenerator === undefined) {
      const result: AgentChildRunResult = { status: CHILD_RUN_STATUSES.FAILED }
      throw createRuntimeChildRunError('delegation ID generator must not be nil', result)
    }
    return this.#options.idGenerator.generate(this.#options.executionPrefix ?? 'SAEX')
  }
}

/** 子执行 ID 是子 Agent 自身 run ID，父请求 ID 只通过 parentRunId 保留。 */
function childRunIdentity(identity: ChildExecutionIdentity, traceId: string): AgentRunIdentity {
  return {
    runId: identity.executionId,
    sessionId: identity.sessionId,
    userId: identity.userId,
    traceId,
    parentRunId: identity.requestId,
  }
}

function buildDelegationUserMessage(request: AgentChildRunRequest): string {
  if (request.executionId !== '') {
    return request.instruction !== '' ? request.instruction : '请继续完成任务。'
  }
  let message = request.instruction
  if (request.context !== '') message += `\n上下文信息：${request.context}`
  if (request.expectedFormat !== '') message += `\n期望返回格式：${request.expectedFormat}`
  return message
}

function failedResult(
  status: ChildRunStatus,
  executionId: string,
  reason: string,
  outcome: AgentExecutionOutcome | undefined
): AgentChildRunResult {
  return { status, executionId, error: reason, ...partialOutput(outcome) }
}

function partialOutput(outcome: AgentExecutionOutcome | undefined): {
  readonly partialOutput?: string | undefined
} {
  const output = lastAssistantContent(outcome?.messages ?? [])
  return output === '' ? {} : { partialOutput: output }
}

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

/** 取最后一条有正文的 assistant 消息；末条可能是工具轮次（content 为 null）或工具结果。 */
function lastAssistantContent(messages: readonly AgentMessage[]): string {
  for (const message of messages.toReversed()) {
    if (message.role === 'assistant' && message.content !== null && message.content !== '') {
      return message.content
    }
  }
  return ''
}
