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
  /** 会话 id，写入投影结果的归属字段。 */
  readonly sessionId: string
  /** 该会话的 run 事实记录，须按 startedAt 升序排列；为空时整体退化为 G0 投影。 */
  readonly runs: readonly SessionRunRecord[]
  /** 该会话的子 Agent 执行记录，按 parent_call_id 供 tool 事实并账。 */
  readonly subExecutions: readonly SubExecutionRecord[]
  /** 该会话的展示消息；用于升级边界前的旧轮次与标题。 */
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
 *
 * 降级语义：事实缺失的维度（usage、终态、时长）以 null 或缺省表达，绝不虚构数值；
 * 首个 run 之前的历史轮次与标题统一走 G0 投影，保证与无事实日志的旧会话同形。
 *
 * @param input - 事实投影输入；runs 为空或首个 run 无 startedAt 时整体退化为 G0 投影。
 * @returns 轮次化会话轨迹；compaction 为单槽（取最近一次），扩展为序列需前端配合。
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
  /** 子执行按 parent_call_id 建立的索引，供 tool 事实识别子 Agent 委派。 */
  readonly #subByCallId: ReadonlyMap<string, SubExecutionRecord>
  /** 本进程启动时刻（epoch ms）；用于区分仍在执行的 run 与崩溃遗留的 running 行。 */
  readonly #processStartedAt: number
  /** 已开出的轮次表；游标即其末尾一项，按事实顺序增长。 */
  readonly #turns: MutableTurn[] = []
  /** 会话级压缩事实；不进轮次记录表，最终由 latestCompaction 取最近一次。 */
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
  /** 全局序号；由投影顺序单调递增，供记录与压缩事件共用。 */
  #seq = 0
  /** 子 Agent 累计 token（会话合计用）；单独计数、不并入主会话 totalTokens。 */
  #subAgentTokens = 0

  public constructor(
    subByCallId: ReadonlyMap<string, SubExecutionRecord>,
    processStartedAt: number
  ) {
    this.#subByCallId = subByCallId
    this.#processStartedAt = processStartedAt
  }

  /**
   * 子 Agent 累计 token（会话合计用）；与 G0 投影口径一致，单独计数、不并入主会话 totalTokens。
   *
   * @returns 本次投影累计的子 Agent token 数。
   */
  public get subAgentTokens(): number {
    return this.#subAgentTokens
  }

  /**
   * 并入一个 run 的全部事实，按事实类型开轮或续轮。
   * user 事实开新一轮；assistant / tool 事实归入当前轮（answer/resume 续写同一轮，不重复开轮）；
   * compaction 是会话级事实，不进轮次记录表，也不得为它新建空轮次（空轮次会被渲染成永不终结的「进行中」）。
   * 只有真正写入过轮次记录的 run 才允许改写本轮终态——空事实 run（启动即失败）不得抹掉上一轮的结局。
   *
   * @param run - 一条已落库的会话运行记录；调用方须按 startedAt 升序传入。
   */
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

  /**
   * 定稿全部轮次：把内部可变的轮次游标转换为对外轨迹轮次，并结算时长与 token。
   * 未终结的轮次其 endState 为 undefined，时长退化为已落库活动区间的下界。
   *
   * @returns 按开始顺序排列的轨迹轮次。
   */
  public finalize(): readonly TrajectoryTurn[] {
    return this.#turns.map(finalizeTurn)
  }

  /**
   * 最近一次压缩（DTO 单槽）；无压缩事实时为 null。
   * DTO 的 compaction 只有一个槽位，多次压缩取 at 最大者，扩展为序列需前端配合。
   *
   * @returns 最近一次压缩记录；从未发生压缩时为 null。
   */
  public latestCompaction(): TrajectoryCompaction | null {
    const latest = this.#compactions.reduce<TrajectoryCompaction | null>(
      (acc, item) => (acc === null || item.at >= acc.at ? item : acc),
      null
    )
    return latest
  }

  /**
   * 压缩事实 → 轨迹压缩记录；`durationMs` 缺省时记 0 以满足 DTO 必填（事实里保留 null 语义）。
   *
   * @param fact - 一条已落库的会话级压缩事实。
   * @param afterTurn - 本次压缩发生时所在的轮次号；尚无轮次时为 0。
   * @returns 轨迹压缩记录。
   */
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

  /**
   * 新开一轮并把游标追加到轮次表；轮次号按已开轮数递增。
   *
   * @param startedAt - 本轮开始时刻（epoch 毫秒），通常取自触发开轮的事实。
   * @returns 新建的可变轮次游标，供调用方继续写入记录。
   */
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

  /**
   * 把一条记录追加到轮次，并在记录时刻更早时回填轮次开始时刻。
   *
   * @param turn - 目标轮次游标。
   * @param record - 待追加的记录，追加后按展开顺序排在末尾。
   */
  #addRecord(turn: MutableTurn, record: TrajectoryRecord): void {
    if (record.at < turn.startedAt) turn.startedAt = record.at
    turn.records.push(record)
  }

  /**
   * 用户事实 → 记录；摘要直接取消息正文，不额外截断。
   *
   * @param fact - 一条已落库的用户事实。
   * @returns 用户记录。
   */
  #userRecord(fact: RunUserFact): TrajectoryRecord {
    return this.#base('user', fact.at, fact.content)
  }

  /**
   * 一条 assistant 事实 → **一个** `call` 记录（一次 LLM 调用）。
   * 不再拆「步骤父行 + 请求子行」：那样在无重试时父子两行携带同一份数据。
   * 时刻取首次尝试的开始时刻，而不是事实的提交时刻（后者含整段调用时长）。
   *
   * @param run - 该事实所属的会话运行记录，用于取模型名与 run id 拼出尝试 id。
   * @param fact - 一条已落库的 assistant 事实。
   * @returns 调用记录；重试明细挂在 `attempts` 上，tokens 取事实的用量。
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
   *
   * @param turn - 该事实所属的当前轮次游标；记录被追加到它上面。
   * @param fact - 一条已落库的工具事实。
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

  /**
   * 非审批工具事实 → 记录：callId 命中子执行时产出子 Agent 行并并账，否则产出普通工具行。
   * 子 Agent 的 token 与耗时以子执行记录为准，普通工具行则用事实自身的值。
   *
   * @param fact - 一条已落库的工具事实（非挂起态）。
   * @returns 记录数组；子 Agent 委派时为单条子 Agent 记录，其余为单条工具记录。
   */
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
   * 否则每个调用点都要展开后再覆盖同一个键，读者得回溯才知道最终摘要。
   *
   * @param kind - 记录种类，决定前端渲染方式，不参与序号分配。
   * @param at - 记录发生时刻（epoch 毫秒）。
   * @param summary - 单行摘要，仅用于列表展示。
   * @returns 已分配序号的记录骨架；调用方按需再补 reply、tokens 等字段。
   */
  #base(kind: TrajectoryRecord['kind'], at: number, summary: string): TrajectoryRecord {
    const seq = this.#nextSeq()
    return { id: `r${seq}`, seq, kind, at, summary }
  }

  /**
   * 取下一个全局序号；记录与压缩事件共用同一序列，保证展示顺序稳定。
   *
   * @returns 自增后的序号。
   */
  #nextSeq(): number {
    this.#seq += 1
    return this.#seq
  }
}

/** 投影过程中可变的轮次游标；`end` 为 undefined 表示该轮尚未终结（仍显示为「进行中」）。 */
interface MutableTurn {
  /** 轮次序号（从 1 开始），由开轮顺序决定。 */
  turn: number
  /** 本轮开始时刻（epoch 毫秒）；可能被更早的记录回填。 */
  startedAt: number
  /** 本轮记录，按事实展开顺序追加。 */
  records: TrajectoryRecord[]
  /** 本轮终态；undefined 表示尚未终结（仍显示为「进行中」）。 */
  end: TrajectoryEndState | undefined
}

/**
 * 由 run 的状态推导轮次终态；仍在执行的 run 返回 undefined（整轮保持「进行中」，绝不虚构终态）。
 * 只有崩溃遗留的 running——开始于本次进程启动之前——才按 `crashed` 收尾。
 * `crashed` 与 `interrupt` 只差一个字母却是两回事：后者是 LLM 主动发起挂起、等待用户作答，
 * 混用会静默改变语义。
 *
 * @param run - 待判定的会话运行记录。
 * @param processStartedAt - 本进程启动时刻（epoch ms），用于识别崩溃遗留的 running。
 * @returns 轮次终态；run 仍在执行时为 undefined。
 */
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

/**
 * run 已落库事实的时间下界：工具事实用结束时刻，其余事实用发生时刻。
 * 用于 run 缺少 `endedAt` 时兜底终态时刻——取的是下界，不是精确的结束时间。
 *
 * @param run - 待取时间下界的会话运行记录。
 * @returns 最晚的事实时刻；run 没有任何事实时为 undefined。
 */
function lastFactAt(run: SessionRunRecord): number | undefined {
  return run.facts.reduce<number | undefined>((acc, fact) => latestOfFact(acc, fact), undefined)
}

/**
 * 取累计下界与单条事实时刻的较大者：工具事实用结束时刻，其余事实用发生时刻。
 *
 * @param acc - 已累计的时间下界；尚无事实时为 undefined。
 * @param fact - 当前参与比较的一条事实。
 * @returns 两者中较大的时刻；acc 为 undefined 时即 fact 的时刻。
 */
function latestOfFact(acc: number | undefined, fact: RunFact): number | undefined {
  const at = fact.type === 'tool' ? fact.startedAt + fact.durationMs : fact.at
  return acc === undefined || at > acc ? at : acc
}

/**
 * 把一轮的游标定稿为对外轮次：结算时长与 token 合计。
 * 轮次 token 含子 Agent 的消耗；完全没有 LLM 步骤的轮次为 null（与 G0 口径一致）；
 * 未终结轮次的时长是「已落库活动区间」的下界，不是最终耗时。
 *
 * @param turn - 投影过程中的可变轮次游标。
 * @returns 定稿后的轨迹轮次。
 */
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

/**
 * 把助手事实的 usage 归一为轨迹 token 用量；usage 缺失时记零而不是 null，
 * 让「这一步确实发生但没有 token 数据」与「根本没有这一步」在 DTO 上仍可区分。
 *
 * @param usage - 助手事实上的 token 用量；为 null 表示该次调用没有采集到用量。
 * @returns 轨迹口径的 token 用量；缺失时 input/output 为 0、cache 为 null。
 */
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
 *
 * @param params - 挂起工具事实的入参；为 null 表示事实里没有留存参数。
 * @returns 审批行摘要；取不到首个问题文本时回落到固定文案「等待用户确认」。
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

/**
 * 取文本首行并施加上限，作为记录摘要。
 * 上限只为拦截「单行超长文本」，不是视觉截断——宽窄容器各显示多少由渲染层负责；
 * 全文仍保留在 thinking / reply 字段里，检查器依赖全文。
 *
 * @param text - 原始文本，可能包含多行与超长单行。
 * @returns 首行文本；超过上限时截断并追加省略号。
 */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > SUMMARY_MAX_CHARS ? `${line.slice(0, SUMMARY_MAX_CHARS)}...` : line
}
