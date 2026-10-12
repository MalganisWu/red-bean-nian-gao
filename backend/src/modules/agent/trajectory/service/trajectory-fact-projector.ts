import type { DisplayMessage } from '../../presentation/model/display-message.js'
import type { SessionRunRecord } from '../../run-facts/model/session-run.js'
import { SESSION_RUN_STATUSES } from '../../run-facts/model/session-run.js'
import { RUN_TOOL_STATUSES, type RunFact } from '../../run-facts/model/run-fact.js'
import type { AgentJsonObject } from '../../model/json-value.js'
import type {
  RunAssistantFact,
  RunCompactionFact,
  RunToolFact,
  RunUserFact,
} from '../../run-facts/model/run-fact.js'
import type { SubExecutionRecord } from '../../subagent/model/sub-execution.js'
import type {
  SessionTrajectory,
  TrajectoryCompaction,
  TrajectoryEndState,
  TrajectoryRecord,
  TrajectoryAttempt,
  TrajectoryTokenUsage,
  TrajectoryTurn,
} from '../model/trajectory.js'
import { projectTrajectory } from './trajectory-projector.js'
import { extractTitle } from './trajectory-section-reader.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

/** 投影输入：事实日志 run 记录 + 子执行索引 + 展示消息（升级边界前的旧轮次与标题用）。 */
export interface ProjectFactsTrajectoryInput {
  readonly sessionId: string
  readonly runs: readonly SessionRunRecord[]
  readonly subExecutions: readonly SubExecutionRecord[]
  readonly messages: readonly DisplayMessage[]
  /**
   * 本进程启动时刻（epoch ms）。running run 只有在本次进程启动之后才开始才可能仍在执行；
   * 早于它开始的 running 行是崩溃遗留（进程已重启，不可能还在跑），按 interrupted 收尾。
   */
  readonly processStartedAt: number
}

/**
 * 把 session_runs 事实日志投影为轮次化轨迹（纯函数，不做 IO）。
 *
 * 口径（R10：token/请求/终态维度从事实日志出）：
 * - user 事实开新一轮；run 内其余事实归入当前轮（answer/resume 续轮不重复开轮）；
 * - assistant 事实 → 步骤记录：tokens/requests 来自 usage 与 attempts（重试即多条请求）；
 * - tool 事实 → 工具行；callId 命中子执行 parent_call_id 时映射为子 Agent 行（token/耗时并账）；
 * - run 终态 → 轮次 turn-end；仍在执行的 run 不产出终态（整轮保持"进行中"），
 *   只有崩溃遗留的 running 才按 interrupted 收尾；
 * - 首个 run 之前的展示消息按 G0 投影保留（升级路径回退），避免旧轮次从轨迹中消失。
 */
export function projectFactsTrajectory(input: ProjectFactsTrajectoryInput): SessionTrajectory {
  const firstRunStartedAt = input.runs[0]?.startedAt
  if (firstRunStartedAt === undefined) {
    return projectTrajectory({
      sessionId: input.sessionId,
      messages: input.messages,
      subExecutions: input.subExecutions,
    })
  }

  // 首个 run 之前的展示消息属于事实日志未覆盖的历史轮次，沿用 G0 投影。
  const legacyMessages = input.messages.filter(
    (message): boolean => message.timestamp < firstRunStartedAt
  )
  const legacy =
    legacyMessages.length > 0
      ? projectTrajectory({
          sessionId: input.sessionId,
          messages: legacyMessages,
          subExecutions: input.subExecutions,
        })
      : null

  const subByCallId = new Map<string, SubExecutionRecord>()
  for (const sub of input.subExecutions) {
    if (sub.parentCallId !== undefined && sub.parentCallId !== '') {
      subByCallId.set(sub.parentCallId, sub)
    }
  }

  const projector = new FactsProjector(subByCallId, input.processStartedAt)
  for (const run of input.runs) projector.addRun(run)
  const turns = [...(legacy?.turns ?? []), ...projector.finalize()]
  // DTO 的 compaction 是单槽（G0 形状）：多次压缩取最近一次；扩展为序列需前端配合。
  const latestCompaction = projector.latestCompaction()

  const first = turns[0]
  const last = turns.at(-1)
  const lastRun = input.runs.at(-1)
  const activeMs = turns.reduce((n, t) => n + t.durationMs, 0)
  const spanMs =
    first !== undefined && last !== undefined
      ? Math.max(0, last.startedAt + last.durationMs - first.startedAt)
      : 0
  // 主会话累计只算 LLM 步骤本身；子 Agent 累计单独给 subAgentTokens（与 G0 口径一致）。
  const totalTokens = turns.reduce((n, t) => n + (t.tokens ?? 0), 0)
  return {
    sessionId: input.sessionId,
    title: extractTitle(input.messages),
    turns,
    compaction: latestCompaction,
    // 会话终态取最后一个 run：仍在执行时不得声称会话已结束（轮次级 endState 不足以判断空事实 run）。
    sessionEnd:
      lastRun === undefined
        ? (legacy?.sessionEnd ?? null)
        : (runEndState(lastRun, input.processStartedAt) ?? null),
    totalTokens: turns.some((t) => t.tokens !== null) ? totalTokens : null,
    subAgentTokens: projector.subAgentTokens,
    activeMs,
    spanMs,
  }
}

/** 事实投影器：轮次游标、全局序号与子 Agent token 累计收在一个对象里。 */
class FactsProjector {
  readonly #subByCallId: ReadonlyMap<string, SubExecutionRecord>
  readonly #processStartedAt: number
  readonly #turns: MutableTurn[] = []
  readonly #compactions: TrajectoryCompaction[] = []
  /**
   * 审批调用的挂起位置（callId → 所在轮次与行下标）。
   * 挂起与闭合是同一 callId 的两条 append-only 记录、且分处两个 run，
   * 闭合到达时就地改这一行，避免一次审批显示成两行。
   */
  readonly #approvalByCallId = new Map<
    string,
    { turn: MutableTurn; index: number; startedAt: number }
  >()
  #seq = 0
  #subAgentTokens = 0

  public constructor(
    subByCallId: ReadonlyMap<string, SubExecutionRecord>,
    processStartedAt: number
  ) {
    this.#subByCallId = subByCallId
    this.#processStartedAt = processStartedAt
  }

  public get subAgentTokens(): number {
    return this.#subAgentTokens
  }

  public addRun(run: SessionRunRecord): void {
    let turn = this.#turns.at(-1)
    /* 本 run 是否真的续写了轮次记录：空事实 run（启动即失败）不得改写上一轮终态 */
    let wroteRecords = false
    for (const fact of run.facts) {
      if (fact.type === 'user') {
        turn = this.#newTurn(fact.at)
        this.#addRecord(turn, this.#userRecord(fact))
        wroteRecords = true
        continue
      }
      // 会话级压缩事实不进轮次记录表，按"发生时所在轮次"落到会话级压缩卡片；
      // 它不产生轮次记录，也不得为它新建空轮次（空轮次会被渲染成永不终结的"进行中"）。
      if (fact.type === 'compaction') {
        this.#compactions.push(this.#compactionRecord(fact, turn?.turn ?? 0))
        continue
      }
      if (turn === undefined) turn = this.#newTurn(run.startedAt)
      if (fact.type === 'assistant') {
        this.#addRecord(turn, this.#assistantRecord(run, fact))
        wroteRecords = true
        continue
      }
      if (fact.type === 'tool') {
        this.#addToolFact(turn, fact)
        wroteRecords = true
      }
    }
    // 同一轮被多个 run 续写时（answer/resume），以最后一个 run 的终态为准；
    // 最后一个 run 仍在执行则整轮回到「进行中」（undefined），绝不虚构终态。
    if (wroteRecords && turn !== undefined) {
      turn.end = runEndState(run, this.#processStartedAt)
    }
  }

  public finalize(): readonly TrajectoryTurn[] {
    return this.#turns.map(finalizeTurn)
  }

  /** 最近一次压缩（DTO 单槽）；无压缩事实时为 null。 */
  public latestCompaction(): TrajectoryCompaction | null {
    const latest = this.#compactions.reduce<TrajectoryCompaction | null>(
      (acc, item) => (acc === null || item.at >= acc.at ? item : acc),
      null
    )
    return latest
  }

  #compactionRecord(fact: RunCompactionFact, afterTurn: number): TrajectoryCompaction {
    const seq = this.#nextSeq()
    return {
      id: `c${seq}`,
      seq,
      afterTurn,
      at: fact.at,
      // DTO durationMs 必填；首轮压缩等无可测调用按 0 展示（事实里保留 null 语义）。
      durationMs: fact.durationMs ?? 0,
      beforeTokens: fact.beforeTokens,
      afterTokens: fact.afterTokens,
      messages: fact.messages,
      status: fact.status,
    }
  }

  #newTurn(startedAt: number): MutableTurn {
    const turn: MutableTurn = {
      turn: this.#turns.length + 1,
      startedAt,
      records: [],
      end: undefined,
    }
    this.#turns.push(turn)
    return turn
  }

  #addRecord(turn: MutableTurn, record: TrajectoryRecord): void {
    if (record.at < turn.startedAt) turn.startedAt = record.at
    turn.records.push(record)
  }

  #userRecord(fact: RunUserFact): TrajectoryRecord {
    return this.#base('user', fact.at, fact.content)
  }

  /**
   * 一条 assistant 事实 → **一个** `call` 记录（一次 LLM 调用）。
   * 不再拆「步骤父行 + 请求子行」：那样在无重试时父子两行携带同一份数据。
   * 时刻取首次尝试的开始时刻，而不是事实的提交时刻（后者含整段调用时长）。
   */
  #assistantRecord(run: SessionRunRecord, fact: RunAssistantFact): TrajectoryRecord {
    const summary = firstLine(fact.content !== '' ? fact.content : fact.thinking)
    const attempts = fact.attempts.map((attempt, index): TrajectoryAttempt => ({
      id: `${run.runId}-req-${index + 1}`,
      seq: this.#nextSeq(),
      model: run.model,
      attempt: `${attempt.attempt}`,
      durationMs: Math.max(0, attempt.endedAt - attempt.startedAt),
      tokens: attempt.usage === null ? null : toTokenUsage(attempt.usage),
      status: attempt.error === undefined ? 'success' : 'error',
      ...optionalField('error', attempt.error),
      at: attempt.startedAt,
    }))
    const firstAttempt = fact.attempts.at(0)
    return {
      ...this.#base('call', firstAttempt?.startedAt ?? fact.at, summary),
      tokens: fact.usage === null ? null : toTokenUsage(fact.usage),
      durationMs: fact.durationMs,
      attempts,
      thinking: fact.thinking === '' ? undefined : fact.thinking,
      reply: fact.content === '' ? undefined : fact.content,
      model: run.model,
    }
  }

  /**
   * 工具事实 → 记录，并按 `callId` 重建审批调用的完整生命周期。
   *
   * 审批在存储层是**同一 callId 的两条 append-only 记录**（挂起在 run N、闭合在 run N+1），
   * 而领域模型与呈现始终是**一次调用、一行**：挂起记录提供 name / params / startedAt，
   * 闭合记录提供 result 与执行耗时，`waitMs = 闭合时刻 − 挂起时刻`（等待与执行分开表达）。
   * 不合并会让一次审批显示成两行，看起来像这个工具跑了两遍。
   */
  #addToolFact(turn: MutableTurn, fact: RunToolFact): void {
    if (fact.status === RUN_TOOL_STATUSES.INTERRUPT) {
      const index = turn.records.length
      this.#addRecord(turn, {
        ...this.#base('tool', fact.startedAt, approvalQuestion(fact.params)),
        name: fact.name,
        status: 'interrupt',
        durationMs: 0,
        params: fact.params === null ? undefined : JSON.stringify(fact.params),
      })
      this.#approvalByCallId.set(fact.callId, { turn, index, startedAt: fact.startedAt })
      return
    }
    const pending = this.#approvalByCallId.get(fact.callId)
    if (pending !== undefined) {
      const previous = pending.turn.records[pending.index]
      if (previous !== undefined) {
        const failed = fact.error !== undefined
        const closedAt = fact.startedAt + fact.durationMs
        pending.turn.records[pending.index] = {
          ...previous,
          durationMs: fact.durationMs,
          status: failed ? 'error' : 'success',
          /* 摘要保留挂起时的问题文本：审批行读的是「当时问了什么」，
             结果与错误另在 result 字段；覆盖成结果会与实时侧（card 事件摘要）不一致，
             流式结束后重拉就会无端变样。 */
          ...(failed
            ? { result: fact.error }
            : fact.result === undefined
              ? {}
              : { result: fact.result }),
          waitMs: Math.max(0, closedAt - pending.startedAt),
        }
      }
      /* 同一 callId 多于两条记录时继续就地更新，取最后一次状态，不重复成行 */
      return
    }
    for (const record of this.#toolRecords(fact)) this.#addRecord(turn, record)
  }

  #toolRecords(fact: RunToolFact): readonly TrajectoryRecord[] {
    const sub = this.#subByCallId.get(fact.callId)
    if (sub !== undefined) {
      // 子 Agent 委派在父 run 里是一次 tool 事实（ADR）；token/耗时以子执行记录为准。
      this.#subAgentTokens += sub.tokensUsed
      return [
        {
          ...this.#base('subagent', fact.startedAt, firstLine(sub.resultSummary ?? sub.agentName)),
          name: sub.agentName,
          model: sub.modelName,
          totalTokens: sub.tokensUsed,
          durationMs: sub.elapsedMilliseconds,
          status: sub.status === 'failed' ? 'error' : 'success',
          result: sub.resultSummary ?? fact.result,
        },
      ]
    }
    const failed = fact.error !== undefined
    const summary = failed
      ? `${fact.name} 失败：${firstLine(fact.error ?? '')}`
      : firstLine(fact.result ?? fact.name)
    return [
      {
        ...this.#base('tool', fact.startedAt, summary),
        name: fact.name,
        status: failed ? 'error' : 'success',
        durationMs: fact.durationMs,
        params: fact.params === null ? undefined : JSON.stringify(fact.params),
        result: failed ? fact.error : fact.result,
      },
    ]
  }

  /** 记录底板：五个必填字段一次给全。`summary` 由调用方传入——底板不填占位值，
   * 否则每个调用点都要展开后再覆盖同一个键，读者得回溯才知道最终摘要。 */
  #base(kind: TrajectoryRecord['kind'], at: number, summary: string): TrajectoryRecord {
    const seq = this.#nextSeq()
    return { id: `r${seq}`, seq, kind, at, summary }
  }

  #nextSeq(): number {
    this.#seq += 1
    return this.#seq
  }
}

interface MutableTurn {
  turn: number
  startedAt: number
  records: TrajectoryRecord[]
  end: TrajectoryEndState | undefined
}

function runEndState(
  run: SessionRunRecord,
  processStartedAt: number
): TrajectoryEndState | undefined {
  // 仍在执行的 run 没有终态：只有开始标记，时长由已落库事实推导（下界），
  // 前端据此显示"进行中"而不是任何终态标签。
  if (run.status === SESSION_RUN_STATUSES.RUNNING) {
    if (run.startedAt >= processStartedAt) return undefined
    // 崩溃遗留：进程重启后该 run 不可能仍在执行。用 crashed 与 interrupt 区分
    // （后者是 LLM 主动发起挂起，两者只差一个字母，混用会静默改变语义）。
    return {
      state: 'crashed',
      at: run.endedAt ?? lastFactAt(run) ?? run.startedAt,
      note: '运行进程中断',
    }
  }
  const at = run.endedAt ?? lastFactAt(run) ?? run.startedAt
  const state =
    run.status === SESSION_RUN_STATUSES.COMPLETED
      ? ('completed' as const)
      : run.status === SESSION_RUN_STATUSES.FAILED
        ? ('failed' as const)
        : run.status === SESSION_RUN_STATUSES.CANCELLED
          ? ('cancelled' as const)
          : run.status === SESSION_RUN_STATUSES.EXHAUSTED
            ? ('exhausted' as const)
            : /* 剩下的终态只可能是 INTERRUPTED：全仓唯一赋值点是 Runtime 的 suspended，
                 语义是「LLM 发起挂起、等待用户作答」，不是中断。 */
              ('interrupt' as const)
  return {
    state,
    at,
    ...optionalField('note', run.error),
  }
}

/** run 已落库事实的时间下界：工具事实用结束时刻，其余事实用发生时刻。 */
function lastFactAt(run: SessionRunRecord): number | undefined {
  return run.facts.reduce<number | undefined>((acc, fact) => latestOfFact(acc, fact), undefined)
}

/** 取累计下界与单条事实时刻的较大者：工具事实用结束时刻，其余事实用发生时刻。 */
function latestOfFact(acc: number | undefined, fact: RunFact): number | undefined {
  const at = fact.type === 'tool' ? fact.startedAt + fact.durationMs : fact.at
  return acc === undefined || at > acc ? at : acc
}

function finalizeTurn(turn: MutableTurn): TrajectoryTurn {
  const end = turn.end
  // 未终结轮次的 end 为 undefined：时长退化为"已落库活动区间"的下界，不是最终耗时。
  const lastAt = turn.records.reduce((n, r) => Math.max(n, r.at), turn.startedAt)
  const stepTokens = turn.records.reduce(
    (n, r) =>
      n +
      (r.kind === 'call' && r.tokens !== null && r.tokens !== undefined
        ? r.tokens.input + r.tokens.output
        : 0),
    0
  )
  const subTokens = turn.records.reduce((n, r) => n + (r.totalTokens ?? 0), 0)
  return {
    turn: turn.turn,
    startedAt: turn.startedAt,
    durationMs: Math.max(0, (end?.at ?? lastAt) - turn.startedAt),
    // 本轮 token 合计含子 Agent；完全没有 LLM 步骤的轮次为 null（与 G0 口径一致）。
    tokens:
      stepTokens + subTokens > 0 || turn.records.some((r): boolean => r.kind === 'call')
        ? stepTokens + subTokens
        : null,
    records: turn.records,
    endState: end,
  }
}

function toTokenUsage(usage: RunAssistantFact['usage']): TrajectoryTokenUsage {
  return usage === null
    ? { input: 0, output: 0, cache: null }
    : { input: usage.promptTokens, output: usage.completionTokens, cache: usage.cacheReadTokens }
}

/**
 * 摘要防御上限：只为拦「单行超长文本」，不作为视觉截断手段——
 * 宽容器多显示、窄容器少显示由渲染层 CSS `truncate` 负责，不按固定字符数硬切。
 * 全文在 thinking / reply 字段里保留，检查器依赖全文。
 */
const SUMMARY_MAX_CHARS = 200

/**
 * 审批行的摘要：取首条问题文本，与实时投影消费 card 事件时的摘要同口径
 * （两态不一致会让流式结束后重拉时无端变样）。参数缺失时回落到固定文案。
 */
function approvalQuestion(params: AgentJsonObject | null): string {
  const questions = params === null ? undefined : params['questions']
  if (Array.isArray(questions)) {
    const first = questions.at(0)
    if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
      const text = first['text']
      if (typeof text === 'string' && text !== '') return firstLine(text)
    }
  }
  return '等待用户确认'
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > SUMMARY_MAX_CHARS ? `${line.slice(0, SUMMARY_MAX_CHARS)}...` : line
}
