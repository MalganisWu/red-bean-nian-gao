import type { AgentExecutionEventSink } from '../../execution/port/agent-executor.js'
import type { AgentMessage } from '../../model/agent-message.js'
import type { AgentModelAdapter } from '../../execution/model/agent-execution-contract.js'
import type { AgentJsonObject } from '../../model/json-value.js'
import { AGENT_STATUS_CODES, type AgentRuntimeEvent } from '../../run/model/agent-runtime-event.js'
import {
  RUN_COMPACTION_STATUSES,
  RUN_FACT_SCHEMA_VERSION,
  RUN_TOOL_STATUSES,
  type RunCompactionFact,
  type RunFact,
} from '../model/run-fact.js'
import {
  type FinalizeSessionRunCommand,
  type StartSessionRunCommand,
} from '../model/session-run.js'
import type { RunFactRepository } from '../port/run-fact-repository.port.js'
import { RunFactModelObserver } from './run-fact-model-observer.js'
import { assistantFactFromSnapshot, RunFactStepBuffer, toolFact } from './run-fact-step-buffer.js'
import { normalizeError } from '../../../../shared/errors/normalize-error.js'

export interface RunFactRecorderOptions {
  readonly run: StartSessionRunCommand
  /** 事件与消息 append 阶段使用的中止信号；终态化允许传入独立的收尾信号。 */
  readonly signal: AbortSignal
  readonly repository: RunFactRepository
  readonly now?: (() => number) | undefined
  /** 事实写入失败只影响审计日志，不影响会话主流程；首次失败经此回调上报诊断。 */
  readonly onError?: ((error: Error) => void) | undefined
}

interface OpenToolCall {
  readonly callId: string
  readonly name: string
  readonly params: AgentJsonObject | null
  readonly startedAt: number
}

const EMPTY_RESPONSE_ERROR = '模型返回空响应'

/**
 * 审批闭合事实的占位工具名：闭合那一刻产品拿不到真实工具名与参数
 * （resume 只注入一条 tool 消息带 callId 与内容）。投影期按 callId 与挂起事实合并，
 * 名称/参数/起止取自挂起记录；占位名只在挂起记录缺失时兜底展示。
 * 取值沿用展示投影既有的 approval 口径（trajectory-record-mappers 的 cardRecord）。
 */
const APPROVAL_CLOSURE_TOOL_NAME = 'approval'

/**
 * 单次运行的事实日志写入器：run 开始时落容器，事件流与消息观察上同步追加
 * user / assistant / tool 三类事实，终态时补记未完成步骤与工具并提交终态（R7/R11）。
 * 写入是尽力语义：仓储失败只上报一次诊断并停写，绝不影响聊天主流程（display_messages 不动）。
 * 该类由 `ProductAgentRunService` 按 run 创建，经 `agent.module.ts` 注入的
 * `RunFactRepository` 持久化；attempt 状态机见 `RunFactStepBuffer`。
 */
export class RunFactRecorder implements AgentExecutionEventSink {
  readonly #repository: RunFactRepository
  readonly #run: StartSessionRunCommand
  readonly #signal: AbortSignal
  readonly #now: () => number
  readonly #onError: ((error: Error) => void) | undefined
  /** 串行化所有仓储写入：保证 facts JSONB 的追加顺序与事件到达顺序一致。 */
  #queue: Promise<void> = Promise.resolve()
  #broken = false
  #step = new RunFactStepBuffer()
  #openTools = new Map<string, OpenToolCall>()
  /**
   * 本次运行已登记过的 callId（tool_start 或 tool_result 事件）。
   * 用于区分「resume 注入的审批闭合 tool 消息」与「普通工具的 tool 消息」——
   * 后者的事实已由 tool_result 事件写过，再写一次会重复成两行。
   */
  #seenToolCalls = new Set<string>()

  public constructor(options: RunFactRecorderOptions) {
    this.#repository = options.repository
    this.#run = options.run
    this.#signal = options.signal
    this.#now = options.now ?? Date.now
    this.#onError = options.onError
  }

  /**
   * 创建 run 容器；等待串行队列以确认首笔写入结果。
   * 这里**刻意 `await`**（与后面所有写入的 fire-and-forget 不同）：
   * 容器是后续所有 fact 的外键，先确认它写成功，仓储不可用时就能立刻进入 `#broken` 状态停写，
   * 而不是把一串注定失败的事实追加排进队列。
   */
  public async start(signal: AbortSignal): Promise<void> {
    this.#enqueue(async (): Promise<void> => {
      await this.#repository.create(this.#run, signal)
    })
    await this.#queue
  }

  /** AgentExecutionEventSink：接收主运行的中性事件（子 Agent envelope 由调用方过滤）。 */
  public publish(event: AgentRuntimeEvent): void {
    switch (event.type) {
      case 'status': {
        // 空响应重试：上一个 attempt 已正常闭合但产出了空内容，按失败归属（R7）。
        // llm_retry 的失败归属已由模型观察 adapter 在流错误时完成，此处无需重复。
        if (event.code === AGENT_STATUS_CODES.LLM_EMPTY_RESPONSE_RETRY) {
          this.#step.markLastClosedError(EMPTY_RESPONSE_ERROR)
        }
        return
      }
      case 'reason':
        this.#step.appendThinking(event.content)
        return
      case 'token':
        // 仅作终态补记的兜底内容；正式 assistant 事实以提交消息为准。
        this.#step.appendContent(event.content)
        return
      case 'tool_start':
        this.#seenToolCalls.add(event.callId)
        this.#openTools.set(event.callId, {
          callId: event.callId,
          name: event.toolName,
          params: event.params,
          startedAt: this.#now(),
        })
        return
      case 'tool_result': {
        this.#seenToolCalls.add(event.callId)
        const tool = this.#openTools.get(event.callId)
        if (tool === undefined) return
        this.#openTools.delete(event.callId)
        const failed = event.error !== undefined && event.error !== ''
        const toolResultFact = toolFact({
          callId: tool.callId,
          name: tool.name,
          params: tool.params,
          startedAt: tool.startedAt,
          durationMs: Math.max(0, this.#now() - tool.startedAt),
          ...(failed ? { error: event.error } : { result: event.content }),
        })
        this.#emitFact(toolResultFact)
        return
      }
      case 'compaction': {
        // 会话级压缩事实（G2/ADR）：耗时可测时取刚结束的摘要 LLM attempt（同时把它
        // 从步骤缓冲移除）；SDK 只在成功路径发事件，其余两态由未来写入端补充。
        const fact: RunCompactionFact = {
          type: 'compaction',
          at: this.#now(),
          trigger: event.trigger,
          beforeTokens: event.preTokens,
          afterTokens: event.postTokens,
          messages: event.messagesSummarized,
          durationMs: this.#step.takeLastAttemptDuration(),
          status: RUN_COMPACTION_STATUSES.SUCCESS,
          schemaVersion: RUN_FACT_SCHEMA_VERSION,
        }
        this.#emitFact(fact)
        return
      }
    }
  }

  /**
   * 观察 Runtime 已提交消息：user 直接落事实，assistant 结算当前步骤缓冲，
   * tool 只处理「审批闭合」这一种（见 #recordApprovalClosure）。
   */
  public onMessage(message: AgentMessage): void {
    if (message.role === 'user') {
      if (message.content === null || message.content === '') return
      const fact: RunFact = {
        type: 'user',
        content: message.content,
        at: this.#now(),
        schemaVersion: RUN_FACT_SCHEMA_VERSION,
      }
      this.#enqueue(async (): Promise<void> => {
        await this.#append(fact)
      })
      return
    }
    if (message.role === 'tool') {
      this.#recordApprovalClosure(message)
      return
    }
    if (message.role !== 'assistant') return
    const snapshot = this.#step.settle(message.content ?? '', this.#now())
    if (snapshot === undefined) return
    const fact = assistantFactFromSnapshot(snapshot, this.#now())
    this.#enqueue(async (): Promise<void> => {
      await this.#append(fact)
    })
  }

  /**
   * 记录审批挂起事实。interrupting 工具在 Runtime 里是屏障——不发 tool_start / tool_result，
   * resume 时也不重新 dispatch——所以「这一步要求过审批」只能由宿主在工具返回 interrupt 信号时
   * 自己落一条。写入点见 ApprovalFactToolDispatcher（run-facts/service）。
   */
  public recordApprovalPending(input: {
    readonly callId: string
    readonly name: string
    readonly params: AgentJsonObject | null
    readonly startedAt: number
  }): void {
    /* 登记 callId：同一次运行内不会再收到闭合消息（运行就挂起了），登记只为防御重复写入 */
    this.#seenToolCalls.add(input.callId)
    const interruptedToolFact = toolFact({
      callId: input.callId,
      name: input.name,
      params: input.params,
      startedAt: input.startedAt,
      durationMs: 0,
      status: RUN_TOOL_STATUSES.INTERRUPT,
    })
    this.#emitFact(interruptedToolFact)
  }

  /** 包裹主运行模型 adapter，观察每次实际 LLM 请求（attempt）。 */
  public observeModel(inner: AgentModelAdapter): AgentModelAdapter {
    return new RunFactModelObserver(this, inner)
  }

  public beginModelAttempt(): void {
    this.#step.beginAttempt(this.#now())
  }

  public recordModelUsage(usage: Parameters<RunFactStepBuffer['recordUsage']>[0]): void {
    this.#step.recordUsage(usage)
  }

  public markModelAttemptError(message: string): void {
    this.#step.markError(message)
  }

  public endModelAttempt(): void {
    this.#step.endAttempt(this.#now())
  }

  /**
   * 终态化：先补记未结算的步骤缓冲与未完成的工具调用（失败轮次不允许悄悄烂尾），
   * 再提交 run 终态命令。取消归属由调用方在命令里给出（chat cancel → user）。
   */
  public async finalize(command: FinalizeSessionRunCommand, signal: AbortSignal): Promise<void> {
    const flushed = this.#step.flush(this.#now())
    if (flushed !== undefined) {
      const fact = assistantFactFromSnapshot(flushed, this.#now())
      this.#enqueue(async (): Promise<void> => {
        await this.#append(fact)
      })
    }
    this.#flushOpenTools()
    this.#enqueue(async (): Promise<void> => {
      await this.#repository.finalize(this.#run.runId, command, signal)
    })
    await this.#queue
  }

  /**
   * 审批闭合：resume 时 Runtime 不重新 dispatch interrupting 工具，而是注入一条
   * `tool` 消息（`default-runtime-run-service.ts` 的 resume 分支），闭合事实只能从这里拿。
   *
   * **只处理本次运行没见过的 callId**：普通工具的 tool 消息与 tool_result 事件是同一次结果的
   * 两个通道，两边都写会重复成两行；而 interrupting 工具没有 tool_start，必然「没见过」。
   */
  #recordApprovalClosure(message: AgentMessage): void {
    const callId = message.toolCallId
    if (callId === undefined || callId === '') return
    if (this.#seenToolCalls.has(callId)) return
    this.#seenToolCalls.add(callId)
    const closureFact = toolFact({
      callId,
      name: APPROVAL_CLOSURE_TOOL_NAME,
      params: null,
      startedAt: this.#now(),
      durationMs: 0,
      result: message.content ?? '',
    })
    this.#emitFact(closureFact)
  }

  /**
   * 运行终态时仍未闭合的工具 → `incomplete`（用户打断 / 崩溃），**不是工具失败**。
   * 用显式 status 而不是写 error：轨迹是审计视图，「被用户打断」与「工具自己报错」是两件事。
   */
  #flushOpenTools(): void {
    const now = this.#now()
    for (const tool of this.#openTools.values()) {
      const incompleteToolFact = toolFact({
        callId: tool.callId,
        name: tool.name,
        params: tool.params,
        startedAt: tool.startedAt,
        status: RUN_TOOL_STATUSES.INCOMPLETE,
        durationMs: Math.max(0, now - tool.startedAt),
      })
      this.#emitFact(incompleteToolFact)
    }
    this.#openTools.clear()
  }

  #emitFact(fact: RunFact): void {
    this.#enqueue(async (): Promise<void> => {
      await this.#append(fact)
    })
  }

  async #append(fact: RunFact): Promise<void> {
    await this.#repository.appendFact(this.#run.runId, fact, this.#signal)
  }

  /** 所有仓储写入的唯一入口：串行 + 尽力语义，首次失败上报并停写。 */
  #enqueue(operation: () => Promise<void>): void {
    this.#queue = this.#queue
      .then((): Promise<void> => (this.#broken ? Promise.resolve() : operation()))
      .catch((cause: unknown): void => {
        this.#broken = true
        this.#onError?.(normalizeError(cause))
      })
  }
}
