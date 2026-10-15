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
  /** 会话 id，写入投影结果的归属字段。 */
  readonly sessionId: string
  /** 该会话的展示消息，按时间先后排列，是本路径唯一的事实来源。 */
  readonly messages: readonly DisplayMessage[]
  /** 该会话的子 Agent 执行记录，按 parent_call_id 供 sub_agent 段并入。 */
  readonly subExecutions: readonly SubExecutionRecord[]
}

/**
 * 展示消息里 section 的类型判别值，与 `trajectory-section-reader` 的读取口径共享同一组常量。
 * 投影的 switch 必须引用这里的成员而非字符串字面量，避免拼写漂移，并让「定义 ↔ 全部使用点」
 * 在 IDE 里双向可跳。
 */
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
 *
 * @param input - 展示投影输入；messages 为持久化的展示消息，subExecutions 供子 Agent 段并入执行记录。
 * @returns 轮次化会话轨迹；本路径无事实日志可用，compaction 恒为 null、totalTokens 恒为 null。
 */
export function projectTrajectory(input: ProjectTrajectoryInput): SessionTrajectory {
  return new Projector(input).project()
}

/** 投影器：把一次性序号分配与轮次游标收在一个对象里，段映射细节委托给 record-mappers。 */
class Projector implements RecordMapperContext {
  /** 投影输入；只读持有，投影过程不回写调用方的入参。 */
  readonly #input: ProjectTrajectoryInput
  /** 子执行按 parent_call_id 建索引，供 sub_agent 段并入。 */
  readonly #subByCallId = new Map<string, SubExecutionRecord>()
  /** 全局记录序号；由投影顺序单调递增，保证同一会话重复投影得到的记录 id 稳定。 */
  #seq = 0
  /** 子 Agent 累计 token（会话合计用）；不计入主会话 totalTokens。 */
  #subAgentTokens = 0

  public constructor(input: ProjectTrajectoryInput) {
    this.#input = input
    for (const sub of input.subExecutions) {
      if (sub.parentCallId !== undefined && sub.parentCallId !== '') {
        this.#subByCallId.set(sub.parentCallId, sub)
      }
    }
  }

  /**
   * 子执行按 `parent_call_id` 建立的索引，供 sub_agent 段在本轮内并入其执行记录。
   * 只读暴露：参与投影的 mapper 都不应改写它的内容。
   *
   * @returns 调用 id 到子执行记录的只读映射；没有对应子执行的调用查不到键。
   */
  public get subByCallId(): ReadonlyMap<string, SubExecutionRecord> {
    return this.#subByCallId
  }

  /**
   * RecordMapperContext：分配全局稳定序号（展示顺序即序号顺序）。
   * 序号在整个会话内单调递增且只由投影顺序决定，因此同一会话重复投影得到稳定的记录 id。
   *
   * @param kind - 记录种类；决定前端如何渲染该行，不参与序号分配。
   * @param at - 记录发生时间（epoch 毫秒），取自消息或分段上的时间戳。
   * @param summary - 单行摘要，仅用于列表展示，不承载完整内容。
   * @returns 已分配序号的记录骨架；调用方按需再补 reply、tokens 等字段。
   */
  public nextRecord(kind: TrajectoryRecord['kind'], at: number, summary: string): TrajectoryRecord {
    this.#seq += 1
    return { id: `r${this.#seq}`, seq: this.#seq, kind, at, summary }
  }

  /**
   * RecordMapperContext：累计子 Agent token（会话合计用）。
   * 子 Agent 的消耗不计入主会话 totalTokens，只在此累加，最终单独体现在 subAgentTokens 上。
   *
   * @param tokens - 本次子 Agent 段消耗的 token；缺 token 数据的段传 0。
   */
  public addSubAgentTokens(tokens: number): void {
    this.#subAgentTokens += tokens
  }

  /**
   * 执行投影：按消息顺序逐轮展开记录，再定稿轮次并汇总会话级指标。
   * user 消息开新一轮，assistant 消息的 sections 逐段落成记录；会话不以用户消息开头时，
   * 首个 assistant 消息自立一轮，保证这段对话不被丢弃。
   *
   * @returns 轮次化的会话轨迹；本路径没有事实日志可用，`compaction` 与 `totalTokens` 恒为 null。
   */
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
      // 会话不以用户消息开始时，首个 assistant 消息自立一轮
      current ??= this.#openTurn(turns, message)
      this.#projectAssistant(current, message)
    }

    const finalized = turns.map((t) => this.#finalizeTurn(t))
    return this.#assemble(finalized)
  }

  // ── 轮次游标 ──

  /**
   * 新开一轮并把游标追加到轮次表；轮次号按已开轮数递增。
   *
   * @param turns - 已收集的轮次表，新轮次会被追加到其末尾。
   * @param message - 触发开轮的展示消息，其时间戳作为本轮的开始时刻。
   * @returns 新建的可变轮次游标，供调用方继续写入记录。
   */
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

  // ── assistant 消息逐段投影 ──

  /**
   * 投影一条 assistant 消息：有 sections 时逐段展开，否则回落到顶层 content。
   * 无 sections 的旧格式只剩顶层正文（think[] 已随存量兼容清理移除）。
   *
   * @param turn - 当前轮次游标，记录被追加到它上面。
   * @param message - 待投影的 assistant 展示消息。
   */
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
    // 无 sections 的旧格式：只剩顶层 content（think[] 已随存量兼容清理移除）
    if (message.content !== undefined && message.content !== '') {
      this.#attachTextReply(turn, message.content, message.timestamp)
      turn.hasReply = true
    }
  }

  // ── 回复并入 ──

  /**
   * 把 content 段并入本轮：上一条若是尚无回复的步骤则就地补写，否则新开一步。
   * 一步 = 思考 + 回复；工具执行后的 content 属于下一步 LLM 调用，即便它没有思考段。
   *
   * @param turn - 当前轮次游标，回复被并入它末尾的步骤或新增步骤。
   * @param section - content 段；正文为空或非字符串时不产生记录。
   */
  #attachReply(turn: MutableTurn, section: SectionLike): void {
    const content = readString(section['content'])
    if (content === null || content === '') return
    const at = section['timestamp']
    const atMs = typeof at === 'number' && Number.isFinite(at) ? at : 0
    // 一步 = 思考 + 回复；仅当上一条是尚无回复的步骤时并入，否则新开一步
    // （工具执行后的 content 属于下一步 LLM 调用，即便它没有思考段）。
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

  /**
   * 旧格式顶层 content 的并入路径，与 `#attachReply` 同口径，只是没有 section 时间戳。
   *
   * @param turn - 当前轮次游标，回复被并入或新开一步。
   * @param content - 顶层回复正文；调用方保证非空。
   * @param at - 该消息的时间戳（epoch 毫秒），用于新开步骤时定位记录时刻。
   */
  #attachTextReply(turn: MutableTurn, content: string, at: number): void {
    const last = turn.records.at(-1)
    if (last !== undefined && last.kind === 'call' && last.reply === undefined) {
      turn.records[turn.records.length - 1] = { ...last, reply: content }
      return
    }
    const base = this.nextRecord('call', at, firstLine(content))
    turn.records.push({ ...base, reply: content, tokens: null, attempts: [] })
  }

  // ── 轮次定稿与会话汇总 ──

  /**
   * 定稿一轮：结算耗时与终态。有回复即视为 completed，否则终态缺省（「进行中」）。
   *
   * @param turn - 待定稿的可变轮次游标。
   * @returns 对外轨迹轮次；本路径无事实日志，tokens 恒为 null。
   */
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

  /**
   * 汇总会话级指标：标题、活动时长、墙钟跨度与子 Agent token。
   * 本路径没有事实日志可用，compaction 与 totalTokens 恒为 null。
   *
   * @param turns - 已定稿的轨迹轮次，按开始顺序排列。
   * @returns 会话轨迹视图。
   */
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
  /** 轮次序号（从 1 开始），由开轮顺序决定。 */
  turn: number
  /** 本轮开始时刻（epoch 毫秒）；可能被更早的记录回填。 */
  startedAt: number
  /** 本轮记录，按展开顺序追加。 */
  records: TrajectoryRecord[]
  /** 本轮是否已产生回复；决定定稿时是否给出 completed 终态。 */
  hasReply: boolean
}
