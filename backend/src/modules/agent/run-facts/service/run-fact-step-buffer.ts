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

interface MutableAttempt {
  attempt: number
  startedAt: number
  endedAt: number | undefined
  usage: RunFactUsage | null
  error: string | undefined
}

/** 一次 LLM 步骤的终态快照（组装 assistant 事实的全部输入）。 */
export interface StepSnapshot {
  readonly startedAt: number | undefined
  readonly thinking: string
  readonly content: string
  readonly attempts: readonly RunFactAttempt[]
  readonly usage: RunFactUsage | null
}

/**
 * 一次 LLM 步骤（一条 assistant 事实）的累积缓冲：
 * attempt 序列、思考与正文增量、usage 归属都在这里收敛，写入器只负责路由与持久化。
 * usage 取最后一次产出用量的 attempt（即产出最终内容的那次），空响应重试把已闭合的
 * attempt 追认为失败，保证 attempts 完整可回放。
 */
export class RunFactStepBuffer {
  #startedAt: number | undefined
  #thinking = ''
  #content = ''
  #attempts: MutableAttempt[] = []
  #open: MutableAttempt | undefined

  get hasContent(): boolean {
    return this.#attempts.length > 0 || this.#thinking !== '' || this.#content !== ''
  }

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

  /** 首个 usage 生效：与 SDK 的 usageCounted 口径一致，后续 usage 块忽略。 */
  recordUsage(usage: AgentTokenUsage): void {
    const open = this.#open
    if (open === undefined || open.usage !== null) return
    open.usage = {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cacheReadTokens: usage.cacheReadTokens ?? null,
    }
  }

  markError(message: string): void {
    const open = this.#open
    if (open === undefined || open.error !== undefined) return
    open.error = message
  }

  /** 空响应重试的追认：最后一个已闭合但无错误的 attempt 改判为失败。 */
  markLastClosedError(message: string): void {
    const last = this.#attempts.at(-1)
    if (last !== undefined && last.error === undefined) {
      last.error = message
      return
    }
    this.markError(message)
  }

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
   */
  takeLastAttemptDuration(): number | null {
    const last = this.#attempts.at(-1)
    if (last === undefined || last.endedAt === undefined) return null
    this.#attempts.pop()
    // 缓冲被取空时重置步骤起点，避免下一步时长把已移除的摘要调用算进去。
    if (this.#attempts.length === 0) this.#startedAt = undefined
    return Math.max(0, last.endedAt - last.startedAt)
  }

  appendThinking(content: string): void {
    this.#thinking += content
  }

  appendContent(content: string): void {
    this.#content += content
  }

  /** 结算快照并清空缓冲；空步骤返回 undefined（恢复/回放路径不产生噪声事实）。 */
  settle(content: string, now: number): StepSnapshot | undefined {
    if (this.#open !== undefined) this.endAttempt(now)
    const hasMessage = content !== ''
    if (!this.hasContent && !hasMessage) return undefined
    const snapshot = this.#snapshot(content)
    this.#reset()
    return snapshot
  }

  /** 终态补记快照：正文用已观察到的增量兜底，缓冲随后清空。 */
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

  #reset(): void {
    this.#startedAt = undefined
    this.#thinking = ''
    this.#content = ''
    this.#attempts = []
    this.#open = undefined
  }
}

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
