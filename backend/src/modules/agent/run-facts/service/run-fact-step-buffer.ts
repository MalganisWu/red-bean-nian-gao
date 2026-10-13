import type { AgentTokenUsage } from '../../execution/model/agent-execution-contract.js'
import type { AgentJsonObject } from '../../model/json-value.js'
import {
  RUN_FACT_SCHEMA_VERSION,
  type RunAssistantFact,
  type RunFactAttempt,
  type RunFactUsage,
  type RunToolFact,
  type RunToolStatus,
} from '../model/run-fact.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

/** attempt 的可变累积态；endedAt 在未闭合时为空，由 freezeAttempt 固化时才补齐。 */
interface MutableAttempt {
  /** 重试序号，从 1 起在步骤内递增。 */
  attempt: number
  /** 本次 attempt 的开始时刻（epoch 毫秒）。 */
  startedAt: number
  /** 本次 attempt 的结束时刻（epoch 毫秒）；未闭合时为 undefined，由 freezeAttempt 固化补齐。 */
  endedAt: number | undefined
  /** 本次 attempt 观察到的用量；未观察到时为 null。 */
  usage: RunFactUsage | null
  /** 本次 attempt 的错误信息；正常结束或尚未得知时为 undefined。 */
  error: string | undefined
}

/** 一次 LLM 步骤的终态快照（组装 assistant 事实的全部输入）。 */
export interface StepSnapshot {
  /** 步骤起点（首次 attempt 的开始时刻）；缓冲无内容时为 undefined，时长按 0 处理。 */
  readonly startedAt: number | undefined
  /** 步骤内累计的思考增量。 */
  readonly thinking: string
  /** 步骤的权威正文：提交消息内容，或终态补记时的增量兜底。 */
  readonly content: string
  /** 步骤内全部 attempt 的冻结序列。 */
  readonly attempts: readonly RunFactAttempt[]
  /** 步骤的用量归属；无带用量的 attempt 时为 null。 */
  readonly usage: RunFactUsage | null
}

/**
 * 一次 LLM 步骤（一条 assistant 事实）的累积缓冲：
 * attempt 序列、思考与正文增量、usage 归属都在这里收敛，写入器只负责路由与持久化。
 * usage 取最后一次产出用量的 attempt（即产出最终内容的那次），空响应重试把已闭合的
 * attempt 追认为失败，保证 attempts 完整可回放。
 */
export class RunFactStepBuffer {
  /** 步骤起点（首次 attempt 的开始时刻）；缓冲清空时复位为 undefined。 */
  #startedAt: number | undefined
  /** 步骤内累计的思考增量。 */
  #thinking = ''
  /** 步骤内累计的正文增量，仅作终态补记的兜底内容。 */
  #content = ''
  /** 已闭合、归档的 attempt 序列。 */
  #attempts: MutableAttempt[] = []
  /** 当前悬挂未闭合的 attempt；无进行中 attempt 时为 undefined。 */
  #open: MutableAttempt | undefined

  /**
   * 是否已积累任何步骤事实（attempt / 思考 / 正文任一非空）。
   * 终态补记用它判断缓冲里是否还有内容可落，避免为无内容的步骤产出噪声事实。
   * @returns 三者任一非空时为 true，全空时为 false
   */
  get hasContent(): boolean {
    return this.#attempts.length > 0 || this.#thinking !== '' || this.#content !== ''
  }

  /**
   * 开启一次新的 LLM attempt；若上一个 attempt 仍悬挂未闭合（流被外部放弃），
   * 先用同一时刻补闭它，保证 attempt 序列始终完整可回放。
   * @param now 本次 attempt 的起始时刻（epoch 毫秒）
   */
  beginAttempt(now: number): void {
    // 上一个 attempt 悬挂未闭合（流被外部放弃）时先闭合，保证 attempt 序列完整。
    if (this.#open !== undefined) this.endAttempt(now)
    this.#open = {
      attempt: this.#attempts.length + 1,
      startedAt: now,
      endedAt: undefined,
      usage: null,
      error: undefined,
    }
    if (this.#startedAt === undefined) this.#startedAt = now
  }

  /**
   * 首个 usage 生效：与 SDK 的 usageCounted 口径一致，后续 usage 块忽略。
   * @param usage 本次 attempt 观察到的 token 用量快照
   */
  recordUsage(usage: AgentTokenUsage): void {
    const open = this.#open
    if (open === undefined || open.usage !== null) return
    open.usage = {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cacheReadTokens: usage.cacheReadTokens ?? null,
    }
  }

  /**
   * 标记当前 attempt 失败；只认首个错误（与 usage 的「首个生效」口径一致），
   * 后续错误块忽略；无悬挂 attempt 时为空操作。
   * @param message 归一化后的错误描述
   */
  markError(message: string): void {
    const open = this.#open
    if (open === undefined || open.error !== undefined) return
    open.error = message
  }

  /**
   * 空响应重试的追认：最后一个已闭合但无错误的 attempt 改判为失败。
   * @param message 归一化后的错误描述，通常为空响应重试的固定文案
   */
  markLastClosedError(message: string): void {
    const last = this.#attempts.at(-1)
    if (last !== undefined && last.error === undefined) {
      last.error = message
      return
    }
    this.markError(message)
  }

  /**
   * 闭合当前悬挂的 attempt 并把它归档进 attempts 序列；无悬挂 attempt 时为空操作（幂等）。
   * @param now 本次 attempt 的结束时刻（epoch 毫秒）
   */
  endAttempt(now: number): void {
    const open = this.#open
    if (open === undefined) return
    open.endedAt = now
    this.#attempts.push(open)
    this.#open = undefined
  }

  /**
   * 取走最后一个已闭合 attempt 的时长并从缓冲移除（G2：压缩摘要调用归属到
   * compaction 事实，同时避免其混入下一步 assistant 事实的 attempts）。
   * 无已闭合 attempt 时返回 null 且不移除。
   * @returns 被取走的已闭合 attempt 时长（毫秒）；无可取 attempt 时为 null
   */
  takeLastAttemptDuration(): number | null {
    const last = this.#attempts.at(-1)
    if (last === undefined || last.endedAt === undefined) return null
    this.#attempts.pop()
    // 缓冲被取空时重置步骤起点，避免下一步时长把已移除的摘要调用算进去。
    if (this.#attempts.length === 0) this.#startedAt = undefined
    return Math.max(0, last.endedAt - last.startedAt)
  }

  /**
   * 追加一截思考增量到当前步骤缓冲；同一步骤内多次调用是累加而非覆盖。
   * @param content 本帧的思考增量文本
   */
  appendThinking(content: string): void {
    this.#thinking += content
  }

  /**
   * 追加一截正文增量，作为终态补记的兜底正文；已提交的 assistant 消息以消息内容为准，
   * 此处的累积只在消息未被观察到的路径（用户打断 / 崩溃）下使用。
   * @param content 本帧的正文增量文本
   */
  appendContent(content: string): void {
    this.#content += content
  }

  /**
   * 结算快照并清空缓冲；空步骤返回 undefined（恢复/回放路径不产生噪声事实）。
   * @param content 本次提交的 assistant 正文，作为快照正文的权威来源
   * @param now 结算时刻（epoch 毫秒），用于闭合仍悬挂的 attempt
   * @returns 步骤快照；缓冲与传入正文皆空时返回 undefined
   */
  settle(content: string, now: number): StepSnapshot | undefined {
    if (this.#open !== undefined) this.endAttempt(now)
    const hasMessage = content !== ''
    if (!this.hasContent && !hasMessage) return undefined
    const snapshot = this.#snapshot(content)
    this.#reset()
    return snapshot
  }

  /**
   * 终态补记快照：正文用已观察到的增量兜底，缓冲随后清空。
   * @param now 补记时刻（epoch 毫秒），用于闭合仍悬挂的 attempt
   * @returns 步骤快照；缓冲为空时返回 undefined（不为空步骤落空事实）
   */
  flush(now: number): StepSnapshot | undefined {
    if (this.#open !== undefined) this.endAttempt(now)
    if (!this.hasContent) return undefined
    const snapshot = this.#snapshot(this.#content)
    this.#reset()
    return snapshot
  }

  /**
   * 组装快照。**usage 取倒数第一个带用量的 attempt**，也就是产出最终内容的那一次——
   * 空响应重试会留下多个 attempt，把前面几次的用量也算进来会虚增 token。
   * 从后往前找而不是取 `attempts.at(-1)`：最后一次 attempt 可能因为流被中断而没有 usage 块。
   * @param content - 作为快照权威正文的文本（提交消息内容或增量兜底）
   * @returns 步骤终态快照；attempt 已冻结为不可变记录
   */
  #snapshot(content: string): StepSnapshot {
    let usage: RunFactUsage | null = null
    for (const attempt of this.#attempts.toReversed()) {
      if (attempt.usage !== null) {
        usage = attempt.usage
        break
      }
    }
    return {
      startedAt: this.#startedAt,
      thinking: this.#thinking,
      content,
      attempts: this.#attempts.map(freezeAttempt),
      usage,
    }
  }

  /** 清空缓冲的全部累积态，为下一次 LLM 步骤复位。 */
  #reset(): void {
    this.#startedAt = undefined
    this.#thinking = ''
    this.#content = ''
    this.#attempts = []
    this.#open = undefined
  }
}

/**
 * 把步骤快照固化成 assistant 事实；缺 `startedAt` 时时长记 0，不留空。
 * @param snapshot 由 settle / flush 产出的步骤终态快照
 * @param now 事实落库时刻（epoch 毫秒），决定事实的 `at` 字段
 * @returns 可直接追加进事实日志的 assistant 事实
 */
export function assistantFactFromSnapshot(snapshot: StepSnapshot, now: number): RunAssistantFact {
  return {
    type: 'assistant',
    at: now,
    durationMs: snapshot.startedAt === undefined ? 0 : Math.max(0, now - snapshot.startedAt),
    usage: snapshot.usage,
    attempts: snapshot.attempts,
    thinking: snapshot.thinking,
    content: snapshot.content,
    schemaVersion: RUN_FACT_SCHEMA_VERSION,
  }
}

/**
 * 由一次工具调用构造 tool 事实；`result`/`error`/`status` 缺省时不写该键，与存量记录保持一致。
 * @param input 单次工具调用的标识、参数与结束状态
 * @returns 可直接追加进事实日志的 tool 事实
 */
export function toolFact(input: {
  readonly callId: string
  readonly name: string
  readonly params: AgentJsonObject | null
  readonly startedAt: number
  readonly result?: string | undefined
  readonly error?: string | undefined
  readonly durationMs?: number | undefined
  /** 只有 interrupt / incomplete 需要显式记；完成与失败由 result / error 推断。 */
  readonly status?: RunToolStatus | undefined
}): RunToolFact {
  return {
    type: 'tool',
    callId: input.callId,
    name: input.name,
    params: input.params,
    ...optionalField('result', input.result),
    ...optionalField('error', input.error),
    startedAt: input.startedAt,
    durationMs: input.durationMs ?? 0,
    ...optionalField('status', input.status),
    schemaVersion: RUN_FACT_SCHEMA_VERSION,
  }
}

/**
 * 固化为不可变的 attempt 记录。
 * `endedAt` 缺失时回退为 `startedAt`（时长为 0）而不是留空：
 * 事实日志是 append-only 的审计视图，一条「开始过但没结束」的尝试也必须能表达出结束时间，
 * 让下游的时长聚合不必到处判空。
 * @param attempt 缓冲里的一次 attempt 可变态
 * @returns 可写入事实日志的不可变 attempt
 */
function freezeAttempt(attempt: MutableAttempt): RunFactAttempt {
  return {
    attempt: attempt.attempt,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt ?? attempt.startedAt,
    usage: attempt.usage,
    ...optionalField('error', attempt.error),
  }
}
