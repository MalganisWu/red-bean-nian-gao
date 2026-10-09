import type { DisplayMessage } from '../../presentation/model/display-message.js'
import type { SubExecutionRecord } from '../../subagent/model/sub-execution.js'
import type { SessionTrajectory, TrajectoryRecord, TrajectoryTurn } from '../model/trajectory.js'
import {
  cardRecord,
  reasonRecord,
  subAgentRecord,
  toolRecords,
  type RecordMapperContext,
} from './trajectory-record-mappers.js'
import {
  extractTitle,
  firstLine,
  readSections,
  readString,
  type SectionLike,
} from './trajectory-section-reader.js'

/** 投影输入：会话展示消息 + 该会话的子 Agent 执行记录。 */
export interface ProjectTrajectoryInput {
  readonly sessionId: string
  readonly messages: readonly DisplayMessage[]
  readonly subExecutions: readonly SubExecutionRecord[]
}

const SECTION_TYPES = Object.freeze({
  REASON: 'reason',
  TOOL_GROUP: 'tool_group',
  CONTENT: 'content',
  CARD: 'card',
  SUB_AGENT: 'sub_agent',
} as const)

/**
 * 把会话的展示消息投影为轮次化轨迹视图（纯函数，不做 IO）。
 *
 * 映射口径：
 * - 每条 user 消息开新一轮；assistant 消息的 sections 逐段展开为记录；
 * - reason → 步骤（思考），content → 并入当前步骤的回复，tool_group → 逐工具一行；
 * - card → 人工确认工具行；sub_agent → 子 Agent 行并按 parent_call_id 并入执行记录；
 * - 无 sections 的旧格式只剩顶层 content 投影（think[] 已随存量兼容清理移除）；
 * - 非法段静默跳过（持久化载荷是宽松 JSON，投影不为脏数据中断）。
 *
 * G0 空值语义：步骤 tokens 为 null、requests 为空数组、主会话 totalTokens 为 null；
 * 轮次终态由"是否有回复"推导为 completed，否则缺省。
 */
export function projectTrajectory(input: ProjectTrajectoryInput): SessionTrajectory {
  return new Projector(input).project()
}

/** 投影器：把一次性序号分配与轮次游标收在一个对象里，段映射细节委托给 record-mappers。 */
class Projector implements RecordMapperContext {
  readonly #input: ProjectTrajectoryInput
  /** 子执行按 parent_call_id 建索引，供 sub_agent 段并入。 */
  readonly #subByCallId = new Map<string, SubExecutionRecord>()
  #seq = 0
  #subAgentTokens = 0

  public constructor(input: ProjectTrajectoryInput) {
    this.#input = input
    for (const sub of input.subExecutions) {
      if (sub.parentCallId !== undefined && sub.parentCallId !== '') {
        this.#subByCallId.set(sub.parentCallId, sub)
      }
    }
  }

  public get subByCallId(): ReadonlyMap<string, SubExecutionRecord> {
    return this.#subByCallId
  }

  /** RecordMapperContext：分配全局稳定序号（展示顺序即序号顺序）。 */
  public nextRecord(kind: TrajectoryRecord['kind'], at: number, summary: string): TrajectoryRecord {
    this.#seq += 1
    return { id: `r${this.#seq}`, seq: this.#seq, kind, at, summary }
  }

  /** RecordMapperContext：累计子 Agent token（会话合计用）。 */
  public addSubAgentTokens(tokens: number): void {
    this.#subAgentTokens += tokens
  }

  public project(): SessionTrajectory {
    const turns: MutableTurn[] = []
    let current: MutableTurn | null = null

    for (const message of this.#input.messages) {
      if (message.role === 'user') {
        current = this.#openTurn(turns, message)
        current.records.push(this.nextRecord('user', message.timestamp, message.content ?? ''))
        continue
      }
      if (message.role !== 'assistant') continue
      /* 会话不以用户消息开始时，首个 assistant 消息自立一轮 */
      current ??= this.#openTurn(turns, message)
      this.#projectAssistant(current, message)
    }

    const finalized = turns.map((t) => this.#finalizeTurn(t))
    return this.#assemble(finalized)
  }

  /* ── 轮次游标 ── */

  #openTurn(turns: MutableTurn[], message: DisplayMessage): MutableTurn {
    const turn: MutableTurn = {
      turn: turns.length + 1,
      startedAt: message.timestamp,
      records: [],
      hasReply: false,
    }
    turns.push(turn)
    return turn
  }

  /* ── assistant 消息逐段投影 ── */

  #projectAssistant(turn: MutableTurn, message: DisplayMessage): void {
    const sections = readSections(message)
    if (sections !== null) {
      for (const section of sections) {
        const type = section['type']
        switch (type) {
          case SECTION_TYPES.REASON: {
            turn.records.push(reasonRecord(section, this))
            break
          }
          case SECTION_TYPES.TOOL_GROUP: {
            for (const record of toolRecords(section, this)) turn.records.push(record)
            break
          }
          case SECTION_TYPES.CONTENT: {
            this.#attachReply(turn, section)
            turn.hasReply = true
            break
          }
          case SECTION_TYPES.CARD: {
            const record = cardRecord(section, this)
            if (record !== null) turn.records.push(record)
            break
          }
          case SECTION_TYPES.SUB_AGENT: {
            const record = subAgentRecord(section, this)
            if (record !== null) turn.records.push(record)
            break
          }
          default:
            break
        }
      }
      return
    }
    /* 无 sections 的旧格式：只剩顶层 content（think[] 已随存量兼容清理移除） */
    if (message.content !== undefined && message.content !== '') {
      this.#attachTextReply(turn, message.content, message.timestamp)
      turn.hasReply = true
    }
  }

  /* ── 回复并入 ── */

  #attachReply(turn: MutableTurn, section: SectionLike): void {
    const content = readString(section['content'])
    if (content === null || content === '') return
    const at = section['timestamp']
    const atMs = typeof at === 'number' && Number.isFinite(at) ? at : 0
    /* 一步 = 思考 + 回复；仅当上一条是尚无回复的步骤时并入，否则新开一步
       （工具执行后的 content 属于下一步 LLM 调用，即便它没有思考段）。 */
    const last = turn.records.at(-1)
    if (last !== undefined && last.kind === 'call' && last.reply === undefined) {
      turn.records[turn.records.length - 1] = {
        ...last,
        reply: content,
        summary: firstLine(content),
      }
      return
    }
    const base = this.nextRecord('call', atMs, firstLine(content))
    turn.records.push({ ...base, reply: content, tokens: null, attempts: [] })
  }

  #attachTextReply(turn: MutableTurn, content: string, at: number): void {
    const last = turn.records.at(-1)
    if (last !== undefined && last.kind === 'call' && last.reply === undefined) {
      turn.records[turn.records.length - 1] = { ...last, reply: content }
      return
    }
    const base = this.nextRecord('call', at, firstLine(content))
    turn.records.push({ ...base, reply: content, tokens: null, attempts: [] })
  }

  /* ── 轮次定稿与会话汇总 ── */

  #finalizeTurn(turn: MutableTurn): TrajectoryTurn {
    const last = turn.records.at(-1)
    const endMs = last !== undefined ? last.at + (last.durationMs ?? 0) : turn.startedAt
    return {
      turn: turn.turn,
      startedAt: turn.startedAt,
      durationMs: Math.max(0, endMs - turn.startedAt),
      tokens: null,
      records: turn.records,
      endState: turn.hasReply ? { state: 'completed', at: endMs } : null,
    }
  }

  #assemble(turns: readonly TrajectoryTurn[]): SessionTrajectory {
    const first = turns[0]
    const last = turns.at(-1)
    const activeMs = turns.reduce((n, t) => n + t.durationMs, 0)
    const spanMs =
      first !== undefined && last !== undefined
        ? Math.max(0, last.startedAt + last.durationMs - first.startedAt)
        : 0
    return {
      sessionId: this.#input.sessionId,
      title: extractTitle(this.#input.messages),
      turns,
      compaction: null,
      sessionEnd:
        last !== undefined ? { state: 'completed', at: last.startedAt + last.durationMs } : null,
      totalTokens: null,
      subAgentTokens: this.#subAgentTokens,
      activeMs,
      spanMs,
    }
  }
}

/** 投影过程中的可变轮次游标。 */
interface MutableTurn {
  turn: number
  startedAt: number
  records: TrajectoryRecord[]
  hasReply: boolean
}
