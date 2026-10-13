'use client'

import {
  Fragment,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '../lib/utils'
import './trajectory.css'
import {
  formatTrajectoryDuration,
  formatTrajectoryGap,
  formatTrajectoryTokens,
  formatTrajectoryWait,
  trajectoryTimeToSeconds,
  type TrajectoryCompaction,
  type TrajectoryGap,
  type TrajectoryRecord,
  type TrajectoryAttempt,
  type TrajectorySessionEnd,
  type TrajectoryTurn,
  type TrajectoryTurnEnd,
} from './trajectoryTypes'

/* 轨迹组件的公开类型经本文件统一 re-export（前端只能经组件文件取类型，类型-only 模块不直接对前端暴露） */
export type {
  TrajectoryCompaction,
  TrajectoryGap,
  TrajectoryRecord,
  TrajectoryRecordKind,
  TrajectoryRecordStatus,
  TrajectoryAttempt,
  TrajectorySessionEnd,
  TrajectoryTokenUsage,
  TrajectoryEndStateValue,
  TrajectoryTurn,
  TrajectoryTurnEnd,
} from './trajectoryTypes'
export {
  formatTrajectoryDuration,
  formatTrajectoryGap,
  formatTrajectoryTokens,
  formatTrajectoryWait,
  hasPrecedingCall,
  trajectoryEndStateLabel,
} from './trajectoryTypes'

/** 轨迹记录表的 Props；`turns` 是唯一必填项，其余都是可选的增强能力。 */
export interface TrajectoryLedgerProps {
  /**
   * 轮次数据（时序排列）。`endState` 缺省表示该轮仍在流式进行中：
   * 标题行渲染「进行中」标记、不渲染终态行，且本轮「时长」只是已知活动区间的下界。
   */
  turns: TrajectoryTurn[]
  /** 会话级压缩事件；渲染为轮次间的虚线卡片，空档由其前后间隔自动推导。 */
  compaction?: TrajectoryCompaction | undefined
  /** 会话结束标记；有值则渲染在记录表尾部。 */
  sessionEnd?: TrajectorySessionEnd | undefined
  /** 耗时条的全会话比例尺（毫秒），默认取最长轮次。 */
  scaleMs?: number | undefined
  /** 搜索过滤文本；命中行高亮摘要，未命中行隐藏。 */
  filterText?: string | undefined
  /**
   * 搜索框内容变化的回调。给了就在表头之上渲染工具栏（折叠全部 / 展开全部 + 搜索）；
   * 不给则只渲染折叠按钮、不渲染搜索框（消费方自己放搜索）。
   * @param text - 搜索框当前文本，调用方据此过滤记录表并高亮命中行。
   */
  onFilterChange?: ((text: string) => void) | undefined
  /** 当前选中记录 id。 */
  selectedId?: string | undefined
  /**
   * 点击记录行 / 压缩卡片时回调。
   * @param id - 被点击记录（或压缩事件）的 id，调用方据此定位检查器内容。
   * @param tab - 期望打开的详情页签；缺省时由检查器自行选择首个可用页签。
   */
  onSelect?: ((id: string, tab?: string) => void) | undefined
  /**
   * 区域聚焦集合（通常来自 TrajectoryTimeline 的 onRangeFocus）：
   * 非 null 时集合之外的记录淡隐；null 表示无聚焦。
   */
  focusIds?: ReadonlySet<string> | null | undefined
}

/** 宽容器七列网格：序号 | 时刻 | 时间轴 | 记录 | token 入·出·缓 | 耗时条 | 时长 */
const GRID_WIDE = 'grid-cols-[34px_64px_20px_minmax(0,1fr)_176px_150px_56px]'

/**
 * 窄容器第二套模板：让出「耗时条」列——它只是「时长」数字的重复表达，最该退让；
 * token 列收窄，「记录」列给出 180px 真实下限。
 *
 * 阈值取 760px 而非"一打开检查器就切换"：宽模板的固定列 500px + 6 个 10px 间隙 = 560px
 * 不参与收缩，再加「记录」列的 180px 可读下限，刚好 740px；低于它就只能牺牲最关键的
 * 「记录」列——`minmax(0,1fr)` 被挤到 0px，`步骤 1` chip 竖排成三行、摘要只剩一个字，
 * 其余列溢出到卡片外。留 20px 余量后：真正需要退让的"检查器打开"场景（记录表被压到 ~530px）
 * 触发切换，而正常桌面宽度（1280 视口下约 858px）仍展示完整七列。
 * 窄模板固定列合计 268px + 5 个间隙 + 180px 下限 = 498px，在 1280 视口打开检查器时的
 * 可用宽度内，避免「时长」列被推到检查器底下。
 * 耗时条单元格用 `@max-[760px]:hidden` 移除，`display:none` 的元素不参与网格流，列数与子元素自然对齐。
 */
const GRID_NARROW = '@max-[760px]:grid-cols-[28px_58px_16px_minmax(180px,1fr)_122px_44px]'

/** 两套模板同时挂载，由最近的 `@container` 根节点宽度切换（容器查询上下文只在根节点建立一次） */
const GRID = `${GRID_WIDE} ${GRID_NARROW}`

/* ---------- 内部小件 ---------- */

/**
 * 产出子行的单行摘要：取首行并在展示层截断。
 * 后端 `SUMMARY_MAX_CHARS` 是**数据**上限（防病态单行），这里是**视觉**截断，
 * 两者职责不同：宽容器能多显示、窄容器少显示，不按固定字符数硬切。
 *
 * @param text - 产出全文（可能多行）。
 * @returns 首行文本；没有内容时返回空串，不虚构占位。
 */
function firstSummaryLine(text: string): string {
  return text.split('\n', 1)[0] ?? ''
}

/**
 * 时间轴节点：形状语言本身也是身份线索（颜色之外），并承载进行中/失败/挂起状态。
 * call 用实心圆，attempt 用小圆点（见 AttemptRow），工具用圆角方，子 Agent 用空心环，
 * 终态标记用空心方——四类形状互不混淆。
 *
 * @param props - 节点属性；字段语义见下方类型。
 */
function AxisNode(props: { kind: TrajectoryRecord['kind']; status?: TrajectoryRecord['status'] }) {
  const { kind, status } = props
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute left-1/2 top-1/2 h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full',
        kind === 'user' && 'bg-brand-indicator',
        kind === 'call' && 'bg-foreground-faint',
        kind === 'tool' && 'rounded-[1.5px]',
        /* 等待审批与未闭合：空心方块——「还没定稿」与「已定稿」在形状上先分开 */
        kind === 'tool' &&
          status === 'interrupt' &&
          'rounded-[1.5px] border-[1.5px] border-cat-tool-indicator bg-background',
        kind === 'tool' &&
          status === 'incomplete' &&
          'rounded-[1.5px] border-[1.5px] border-control-border bg-background',
        kind === 'tool' &&
          status !== 'error' &&
          status !== 'interrupt' &&
          status !== 'incomplete' &&
          'bg-cat-tool-indicator',
        kind === 'tool' && status === 'error' && 'bg-danger-indicator',
        kind === 'subagent' && 'h-[9px] w-[9px] border-2 border-cat-sub-indicator bg-background',
        kind === 'turn-end' && 'rounded-[1.5px] border-[1.5px] border-control-border bg-background',
        kind === 'session-end' && 'h-[9px] w-[9px] border-2 border-foreground-faint bg-background',
        /* 进行中：唯一呼吸节点（与 ProcessFold 的 active 节点同语言） */
        status === 'running' &&
          'bg-process-node-active motion-safe:animate-[process-breathe_1.8s_ease-in-out_infinite]'
      )}
    />
  )
}

/**
 * 耗时胶囊条：宽度占全会话比例尺的百分比。
 *
 * @param props - 条属性；字段语义见下方类型。
 */
function DurationBar(props: {
  ms: number | undefined
  tone: 'call' | 'tool' | 'err' | 'sub' | 'turn' | 'cmp'
  scaleMs: number
}) {
  const { ms, tone, scaleMs } = props
  if (ms === undefined) return null
  const width = Math.max((ms / scaleMs) * 100, 2)
  return (
    <span className="relative block h-full w-full">
      <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-border opacity-55" />
      <i
        title={formatTrajectoryDuration(ms)}
        style={{ width: `${width}%` }}
        className={cn(
          'absolute left-0 top-1/2 block h-1.5 min-w-1 -translate-y-1/2 rounded-full',
          tone === 'call' && 'bg-foreground-faint',
          tone === 'tool' && 'bg-cat-tool-indicator',
          tone === 'err' && 'bg-danger-indicator',
          tone === 'sub' && 'h-2 border border-cat-sub-indicator bg-cat-sub-soft',
          tone === 'turn' && 'bg-foreground-faint/55',
          tone === 'cmp' && 'bg-cat-cmp-indicator'
        )}
      />
    </span>
  )
}

/**
 * 身份 chip：**soft 底 + 1px indicator 描边**。
 *
 * 白底上 soft 填充档整体只有 1.06–1.13:1（WCAG 非文字边界下限 3:1），单靠填充承载不了身份；
 * 描边取 indicator 档（3.26–3.39:1）才读得出来。模板是本来就合规的子 Agent chip。
 *
 * 工具的状态**并入 chip**（沿用「工具 · 失败」的既有做法）：窄容器下「记录」列约 262px，
 * 放不下「chip + 工具名 + 目标 + 状态徽章 + 等待时长」五项；有状态时目标让位，
 * 完整目标与参数在检查器。
 *
 * @param props - 组件属性；`record` 为待渲染的记录，其 `kind` / `status` 决定 chip 文案与配色。
 */
function KindChip(props: { record: TrajectoryRecord }) {
  const { record } = props
  if (record.kind === 'user') {
    return (
      <span className="inline-flex h-[19px] items-center rounded-md border border-brand-indicator bg-primary-soft px-[5px] py-0 text-label leading-none font-semibold tracking-[0.035em] text-brand-text">
        用户
      </span>
    )
  }
  if (record.kind === 'call') {
    return (
      <span className="inline-flex h-[19px] items-center rounded-md border border-control-border bg-muted px-[5px] py-0 text-label leading-none font-semibold tracking-[0.035em] text-foreground-secondary">
        LLM 调用
      </span>
    )
  }
  if (record.kind === 'subagent') {
    return (
      <span className="inline-flex h-[19px] items-center rounded-md border border-cat-sub-indicator bg-cat-sub-soft px-[5px] py-0 text-label leading-none font-semibold tracking-[0.035em] text-cat-sub-text">
        子 Agent
      </span>
    )
  }
  /* ── 工具：状态并入 chip ── */
  if (record.status === 'error') {
    return (
      <span className="inline-flex h-[19px] items-center rounded-md border border-danger-indicator bg-danger-bg px-[5px] py-0 text-label leading-none font-semibold tracking-[0.035em] text-danger-text">
        工具执行 · 失败
      </span>
    )
  }
  /* LLM 发起挂起（等审批）：用品牌色提示「需要你」——注意与「用户」同色系，
     但两者行位与文案都不同，且这正是一次等待人的动作。 */
  if (record.status === 'interrupt') {
    return (
      <span className="inline-flex h-[19px] items-center rounded-md border border-brand-indicator bg-primary-soft px-[5px] py-0 text-label leading-none font-semibold tracking-[0.035em] text-brand-text">
        工具执行 · 等待审批
      </span>
    )
  }
  /* 用户打断、没有结果：中性色，它不是失败 */
  if (record.status === 'incomplete') {
    return (
      <span className="inline-flex h-[19px] items-center rounded-md border border-control-border bg-muted px-[5px] py-0 text-label leading-none font-semibold tracking-[0.035em] text-foreground-muted">
        工具执行 · 未闭合
      </span>
    )
  }
  return (
    <span className="inline-flex h-[19px] items-center rounded-md border border-cat-tool-indicator bg-cat-tool-soft px-[5px] py-0 text-label leading-none font-semibold tracking-[0.035em] text-cat-tool-text">
      工具执行
    </span>
  )
}

/**
 * 产出子行：`call` 的 `thinking` / `reply` **字段投影行**，不是记录类型、不占身份调色板。
 * 与检查器的「思考 / 输出」两 tab 同源；展开只显示首行（表格行高必须一致），
 * 全文仍在检查器。点击选中**所属调用**——产出没有独立记录 id。
 *
 * @param props - 组件属性；字段语义见下方类型。
 */
function OutputRow(props: {
  label: string
  text: string
  callId: string
  selectedId: string | undefined
  onSelect: ((id: string, tab?: string) => void) | undefined
  filterText: string
}) {
  const { label, text, callId, selectedId, onSelect, filterText } = props
  const q = filterText.trim().toLowerCase()
  const hit = !q || text.toLowerCase().includes(q)
  return (
    <div
      role="button"
      tabIndex={0}
      data-output-of={callId}
      aria-selected={selectedId === callId}
      data-hidden={!hit || undefined}
      /* 带上 label：点「正文」就该看到正文，而不是默认停在「思考」tab */
      onClick={() => onSelect?.(callId, label)}
      className={cn(
        `relative grid min-h-[30px] cursor-default ${GRID} items-center gap-x-2.5 border-b border-border/40 transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring`,
        'hover:bg-surface-hover',
        /* 产出没有独立记录 id：所属调用被选中时同步高亮，视觉上保持连续 */
        selectedId === callId && 'bg-primary-soft'
      )}
    >
      <span />
      <span />
      <span className="relative self-stretch">
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-1/2 top-0 w-px bg-border-strong"
        />
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-label font-medium text-foreground-muted">{label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground-body">
          {firstSummaryLine(text)}
        </span>
      </span>
      <span />
      {/* 「耗时条」列占位：窄模板 6 列下该列被移除，必须同步隐藏，否则掉进隐式第二行 */}
      <span className="@max-[760px]:hidden" />
      <span />
    </div>
  )
}

/**
 * 尝试子行：**字段投影行，不是记录类型**——它是所属 `call` 的 `attempts[]` 明细。
 * 因此不复用 `LedgerRow`（那需要伪造一个 kind），也不占身份调色板（无 chip）。
 * 「尝试 N/M」是唯一标签，失败时把原因接在后面。
 *
 * @param props - 组件属性；字段语义见下方类型。
 */
function AttemptRow(props: {
  attempt: TrajectoryAttempt
  seq: number | undefined
  scaleMs: number
  selectedId: string | undefined
  onSelect: ((id: string) => void) | undefined
  filterText: string
}) {
  const { attempt, seq, scaleMs, selectedId, onSelect, filterText } = props
  const q = filterText.trim().toLowerCase()
  const hit =
    !q ||
    [attempt.model, attempt.attempt, attempt.error]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q)
  const failed = attempt.status === 'error'

  /** 键盘等价于点击：Enter / 空格选中这条尝试。 */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect?.(attempt.id)
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      data-attempt-id={attempt.id}
      aria-selected={selectedId === attempt.id}
      data-hidden={!hit || undefined}
      onClick={() => onSelect?.(attempt.id)}
      onKeyDown={handleKeyDown}
      className={cn(
        `relative grid min-h-[30px] cursor-default ${GRID} items-center gap-x-2.5 border-b border-border/40 transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring`,
        'hover:bg-surface-hover',
        selectedId === attempt.id && 'bg-primary-soft'
      )}
    >
      {selectedId === attempt.id && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 z-[5] w-[3px] bg-brand-indicator"
        />
      )}
      <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-faint">
        {seq !== undefined ? `#${seq}` : ''}
      </span>
      <span className="text-label tabular-nums tracking-[0.02em] text-foreground-faint" />
      <span className="relative self-stretch">
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-1/2 top-0 w-px bg-border-strong"
        />
        {/* 尝试节点：小圆点，与调用的实心圆区分 */}
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground-faint"
        />
      </span>
      {/* pl-4：子记录缩进，层级不只靠字号 */}
      <span className="flex min-w-0 items-center gap-2 pl-4">
        <span className="shrink-0 text-label font-medium text-foreground-muted">
          尝试 {attempt.attempt}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs',
            failed ? 'text-danger-text' : 'text-foreground-secondary'
          )}
        >
          {attempt.model}
          {failed
            ? ` · 失败${attempt.error !== undefined ? ` · ${attempt.error}` : ''}`
            : ' · 成功'}
        </span>
      </span>
      <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-muted @max-[760px]:truncate">
        {attempt.tokens && (
          <>
            <span className="text-foreground-faint">入</span>{' '}
            {formatTrajectoryTokens(attempt.tokens.input)}
            <span className="text-foreground-faint"> · 出</span>{' '}
            {formatTrajectoryTokens(attempt.tokens.output)}
            <span className="@max-[760px]:hidden">
              <span className="text-foreground-faint"> · 缓</span>{' '}
              {formatTrajectoryTokens(attempt.tokens.cache)}
            </span>
          </>
        )}
      </span>
      <span className="block @max-[760px]:hidden">
        <DurationBar ms={attempt.durationMs} tone="call" scaleMs={scaleMs} />
      </span>
      <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-muted">
        {attempt.status === 'running' ? '—' : formatTrajectoryDuration(attempt.durationMs)}
      </span>
    </div>
  )
}

/* ---------- 行 ---------- */

/**
 * 把一轮的扁平记录分成「请求组」与「独立行」。
 *
 * 领域层级是 轮次 → 请求 → 产出：一条 `call` 记录开启一个请求，
 * 紧随其后的 `tool` 记录属于这次请求（`hasPrecedingCall` 的同一规则）；
 * 请求的产出 = 该 `call` 的 `thinking` / `reply` + 它引发的工具调用。
 *
 * **不改契约**：wire 上仍是扁平 `records[]`，分组在渲染层按位置推导。
 */
export type TurnItem =
  | { readonly kind: 'plain'; readonly record: TrajectoryRecord }
  | {
      readonly kind: 'request'
      readonly index: number
      readonly call: TrajectoryRecord
      /** 这次请求**写出**的工具调用（模型产出），与思考/正文并列。 */
      readonly callBlocks: readonly TrajectoryRecord[]
    }
  | {
      readonly kind: 'system-run'
      /** 系统执行的对象：工具执行或子 Agent 委派。 */
      readonly record: TrajectoryRecord
    }

/**
 * 把一轮的扁平记录分成**交替的阶段序列**：请求 → 系统执行 → 请求 → …
 *
 * 领域模型不是树：
 * - 请求的**产出** = 该 `call` 的 `thinking` / `reply` + 它写出的工具调用（都是**模型生成**的字符串）
 * - **系统执行**（工具执行 / 子 Agent 委派）是**独立阶段**，与请求平级，不属于任何请求——
 *   它不产出模型 token，且发生在两次请求之间
 *
 * 所以这里**不把工具收进请求的子项**：那样等于把独立阶段当成请求的成员，与模型冲突。
 * 分组只按位置切段，`next request` 之前的系统执行独立成项；视觉上仍是请求 → 其产出 → 系统执行。
 *
 * @param records - 一轮内按时序排列的扁平记录。
 * @returns 按阶段切分的项列表；系统执行与请求平级，不挂进任何请求。
 */
export function groupRequests(records: readonly TrajectoryRecord[]): TurnItem[] {
  const items: TurnItem[] = []
  let requestIndex = 0
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (record === undefined) continue
    if (record.kind === 'tool' || record.kind === 'subagent') {
      items.push({ kind: 'system-run', record })
      continue
    }
    if (record.kind !== 'call') {
      items.push({ kind: 'plain', record })
      continue
    }
    requestIndex += 1
    /* 这次请求写出的工具调用 = 紧随其后、属于它的 tool 记录（它们同时也会作为系统执行再出现一次）。
       只用于渲染「工具调用」这一**模型产出**行；不是把系统执行挂到请求下面。 */
    const callBlocks: TrajectoryRecord[] = []
    let j = i + 1
    while (j < records.length) {
      const next = records[j]
      if (next === undefined || (next.kind !== 'tool' && next.kind !== 'subagent')) break
      callBlocks.push(next)
      j += 1
    }
    items.push({ kind: 'request', index: requestIndex, call: record, callBlocks })
  }
  return items
}

/**
 * 「工具调用」行的文本：模型写出的调用意图 = 工具名 + 参数。
 * 与紧随其后的「工具执行」行（系统阶段，带结果与耗时）是两件事。
 *
 * @param tool - 工具记录；`name` / `target` 缺省时按空串处理。
 * @returns `name(target)` 形式；只有名字时返回名字，两者皆空时返回空串。
 */
function toolCallText(tool: TrajectoryRecord): string {
  const name = tool.name ?? ''
  const target = tool.target ?? ''
  return target === '' ? name : `${name}(${target})`
}

/**
 * 轮次的三段 token 合计 = 本轮各次请求的三段求和。
 *
 * 不用 `turn.tokens`（那是「轮次合计」单一数字，拆不出入/出/缓）；
 * 各请求的 `tokens` 是调用级三段，求和即可。全部为未采集时返回 undefined（显示占位，不虚构 0）。
 *
 * @param records - 本轮按时序排列的扁平记录。
 * @returns 三段合计；本轮没有任何带 token 的 call 时为 undefined。
 */
function turnUsage(
  records: readonly TrajectoryRecord[]
): { input: number; output: number; cache: number } | undefined {
  const calls = records.filter((r) => r.kind === 'call' && r.tokens !== undefined)
  if (calls.length === 0) return undefined
  return calls.reduce(
    (acc, r) => ({
      input: acc.input + (r.tokens?.input ?? 0),
      output: acc.output + (r.tokens?.output ?? 0),
      cache: acc.cache + (r.tokens?.cache ?? 0),
    }),
    { input: 0, output: 0, cache: 0 }
  )
}

/**
 * 请求的模型名：记录级缺失时回落到最后一次尝试携带的模型。
 *
 * @param call - 调用记录；wire 上模型常挂在 attempt 里。
 * @returns 模型名；记录级与尝试级都缺失时为 undefined（消费方不渲染模型槽）。
 */
function requestModel(call: TrajectoryRecord): string | undefined {
  return call.model ?? call.attempts?.at(-1)?.model
}

/**
 * 不可变地切换集合里的一项：有则删、无则加。
 *
 * @param source - 原集合；不直接改写，保证 React 状态引用变化可被侦测。
 * @param value - 要切换的项。
 * @returns 新的集合实例。
 */
function toggleInSet<T>(source: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(source)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

/**
 * 不可变地从集合里删掉一项。
 *
 * @param source - 原集合；不直接改写。
 * @param value - 要删除的项。
 * @returns 新的集合实例（不存在该项时内容不变但仍是新实例）。
 */
function removeFromSet<T>(source: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(source)
  next.delete(value)
  return next
}

/**
 * 请求头行：一次模型网关调用。承载这次请求的模型、尝试序、**入/出 token** 与耗时。
 *
 * 输出 token **不拆到各块产出上**（Provider 只返回整次响应的总量，不返回分块），
 * 所以「出」挂在这里，思考/正文/工具调用共享它，不虚构分块数字。
 *
 * @param props - 组件属性；字段语义见下方类型。
 */
function RequestHeaderRow(props: {
  index: number
  call: TrajectoryRecord
  toolCount: number
  selectedId: string | undefined
  onSelect: ((id: string, tab?: string) => void) | undefined
  /** 该请求的工具执行是否已折叠成摘要行。 */
  folded?: boolean | undefined
  /** 折叠开关；缺省表示该请求没有可折叠的工具执行。 */
  onToggleFold?: (() => void) | undefined
}) {
  const { index, call, toolCount, selectedId, onSelect, folded, onToggleFold } = props
  /** 键盘等价于点击：Enter / 空格选中这次请求。 */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect?.(call.id, '概览')
    }
  }

  /** 点请求边界圆点：只选中这次调用，不触发行选中。 */
  function handleBoundaryClick(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation()
    onSelect?.(call.id, '概览')
  }

  /** 点折叠箭头：只切换折叠，不触发行选中。 */
  function handleToggleFoldClick(event: MouseEvent<SVGSVGElement>): void {
    event.stopPropagation()
    onToggleFold?.()
  }

  return (
    <div
      role="button"
      tabIndex={0}
      data-request-index={index}
      data-request-id={call.id}
      aria-selected={selectedId === call.id}
      /* 点请求行 → 打开该次调用的详情（模型 / 入·出·缓 / 尝试明细）。
         tab 固定给「概览」：请求的默认落点就是这次调用的用量与耗时。 */
      onClick={() => onSelect?.(call.id, '概览')}
      onKeyDown={handleKeyDown}
      className={cn(
        `relative grid min-h-[30px] cursor-default ${GRID} items-center gap-x-2.5 border-b border-border/40 transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring`,
        'bg-[color-mix(in_srgb,var(--foreground)_3%,var(--background))]',
        'hover:bg-surface-hover',
        selectedId === call.id && 'bg-primary-soft'
      )}
    >
      {selectedId === call.id && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 z-[5] w-[3px] bg-brand-indicator"
        />
      )}

      {/* 请求边界圆点：16×16 可点靶点，5px 圆点 + 白环挖洞；hover/聚焦出标签。
          它是「这里是请求边界」的锚点；点它不触发行选中。 */}
      <button
        type="button"
        aria-label={`请求 #${index}`}
        onClick={handleBoundaryClick}
        className="group absolute left-3 top-[-8px] z-[6] inline-flex h-4 w-4 items-center justify-center rounded-full focus-visible:outline-none"
      >
        <span
          aria-hidden="true"
          className="h-[5px] w-[5px] rounded-full bg-control-border shadow-[0_0_0_2px_var(--background)] transition-colors group-hover:bg-brand-indicator group-focus-visible:bg-brand-indicator"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-[18px] -translate-x-1/2 whitespace-nowrap rounded-xs border border-border bg-background px-1 font-mono text-[9px] leading-3 text-foreground-body opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          请求 #{index}
        </span>
      </button>
      <span />
      <span className="text-label tabular-nums tracking-[0.02em] text-foreground-faint">
        {call.at}
      </span>
      <span className="relative self-stretch">
        {/* 请求节点：空心中圆，比轮次（空心大圆）小、比产出（细点）大 */}
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 h-[8px] w-[8px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-control-border bg-background"
        />
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {onToggleFold !== undefined && (
          <ChevronRight
            aria-hidden="true"
            onClick={handleToggleFoldClick}
            className={cn(
              'h-3 w-3 shrink-0 cursor-pointer text-foreground-faintest transition-transform',
              !folded && 'rotate-90'
            )}
            strokeWidth={1.4}
          />
        )}
        <span className="shrink-0 text-label font-medium text-foreground-muted">请求</span>
        <span className="shrink-0 text-[12px] font-semibold tabular-nums text-foreground">
          {index}
        </span>
        {/* 模型名优先取记录级；记录没有时回落到最后一次尝试（wire 上模型挂在 attempt 里） */}
        {requestModel(call) !== undefined && (
          <span className="shrink-0 font-mono text-xs text-foreground-secondary">
            {requestModel(call)}
          </span>
        )}
        <span className="shrink-0 text-label text-foreground-muted">
          尝试 {call.attempts?.at(-1)?.attempt ?? '1/1'}
          {toolCount > 0 ? ` · 工具 ×${toolCount}` : ''}
        </span>
      </span>
      <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-muted @max-[760px]:truncate">
        {call.tokens ? (
          <>
            <span className="text-foreground-faint">入</span>{' '}
            {formatTrajectoryTokens(call.tokens.input)}
            <span className="text-foreground-faint"> · 出</span>{' '}
            {formatTrajectoryTokens(call.tokens.output)}
          </>
        ) : (
          '—'
        )}
      </span>
      <span className="block @max-[760px]:hidden" />
      <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-muted">
        {formatTrajectoryDuration(call.durationMs)}
      </span>
    </div>
  )
}

/**
 * 终态行：**终止符不是同级身份**——所以不用身份 chip，而是「细规则 + 空心终态 chip」
 * （空心 = 只描边不填充，与身份 chip 的软底形成形态差；颜色只表达状态）。
 *
 * wire 只带机制值，文案由 `END_STATE_LABEL` 在此映射：
 * `interrupt` → 「等待用户」（LLM 发起挂起，**不是**中断）、`crashed` → 「已中断」。
 *
 * @param props - 组件属性；字段语义见下方类型。
 */
function EndRow(props: {
  record: TrajectoryRecord
  state: TrajectoryTurnEnd['state']
  selectedId: string | undefined
  onSelect: ((id: string) => void) | undefined
  filterText: string
}) {
  const { record, state, selectedId, onSelect, filterText } = props
  const q = filterText.trim().toLowerCase()
  const hit = !q || record.summary.toLowerCase().includes(q)
  const tone =
    state === 'completed'
      ? 'border-success-indicator text-success-text'
      : state === 'failed'
        ? 'border-danger-indicator text-danger-text'
        : state === 'interrupt'
          ? 'border-brand-indicator text-brand-text'
          : 'border-control-border text-foreground-muted'

  /** 键盘等价于点击：Enter / 空格选中这条终态记录。 */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect?.(record.id)
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      data-record-id={record.id}
      aria-selected={selectedId === record.id}
      data-hidden={!hit || undefined}
      onClick={() => onSelect?.(record.id)}
      onKeyDown={handleKeyDown}
      className={cn(
        `relative grid min-h-[30px] cursor-default ${GRID} items-center gap-x-2.5 border-b border-border/40 transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring`,
        'hover:bg-surface-hover',
        selectedId === record.id && 'bg-primary-soft'
      )}
    >
      <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-faint">
        {record.seq !== undefined ? `#${record.seq}` : ''}
      </span>
      <span className="text-label tabular-nums tracking-[0.02em] text-foreground-faint">
        {record.at}
      </span>
      <span className="relative self-stretch">
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-1/2 top-0 w-px bg-border-strong"
        />
        <AxisNode kind={record.kind} status={record.status} />
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {/* 细规则：把终态与记录行在视觉上分开，而不是再加一个身份 chip */}
        <span aria-hidden="true" className="h-px w-3.5 shrink-0 bg-control-border" />
        <span
          className={cn(
            'inline-flex h-[19px] shrink-0 items-center rounded-md border bg-transparent px-[5px] py-0 text-label leading-none font-semibold tracking-[0.035em]',
            tone
          )}
        >
          {END_STATE_LABEL[state]}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground-muted">
          {record.summary}
        </span>
      </span>
      <span />
      {/* 「耗时条」列占位：窄模板 6 列下该列被移除，必须同步隐藏，否则掉进隐式第二行 */}
      <span className="@max-[760px]:hidden" />
      <span />
    </div>
  )
}

/**
 * 通用记录行：身份 chip + 摘要 + token 列 + 耗时条 + 时长的七列网格行，
 * 承载普通记录与系统执行（工具 / 子 Agent）。
 *
 * `kind=call` 的产出（思考 / 正文）与尝试明细按需展开为子行，默认折叠 —— 审计优先看
 * 「做了什么」，默认展开会让每个调用多出 1–2 行，密度翻倍。用户消息等即时事件没有耗时，
 * 「时长」列留空而非填 0。子 Agent 的内部工具通过 `children` 递归渲染。
 *
 * @param props - 组件属性；字段语义见下方类型。
 */
function LedgerRow(props: {
  record: TrajectoryRecord
  scaleMs: number
  selectedId: string | undefined
  onSelect: ((id: string) => void) | undefined
  filterText: string
  isChild?: boolean
  focusIds?: ReadonlySet<string> | null | undefined
}) {
  const { record, scaleMs, selectedId, onSelect, filterText, isChild, focusIds } = props
  /* 产出（思考/正文）与尝试明细默认**折叠**：审计优先看「做了什么」，
     需要原文时再展开——默认展开会让每个调用都多出 1–2 行，密度翻倍。 */
  const [childrenOpen, setChildrenOpen] = useState(false)
  const q = filterText.trim().toLowerCase()
  const hit =
    !q ||
    [
      record.summary,
      record.name,
      record.target,
      record.thinking,
      record.reply,
      record.params,
      record.result,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q)

  const barTone =
    record.kind === 'call'
      ? 'call'
      : record.kind === 'subagent'
        ? 'sub'
        : record.status === 'error'
          ? 'err'
          : 'tool'

  const hasOutput = record.thinking !== undefined || record.reply !== undefined
  const collapsible =
    record.kind === 'subagent' ||
    (record.kind === 'call' && (hasOutput || (record.attempts?.length ?? 0) > 1))
  const isInstant = record.durationMs === undefined
  const isEnd = record.kind === 'turn-end' || record.kind === 'session-end'

  /** 键盘等价于点击：Enter / 空格选中这条记录。 */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect?.(record.id)
    }
  }

  /** 展开 / 收起这条记录的产出与尝试明细，不触发行选中。 */
  function handleToggleChildren(event: MouseEvent<SVGSVGElement>): void {
    event.stopPropagation()
    setChildrenOpen((v) => !v)
  }

  return (
    <Fragment>
      <div
        role="button"
        tabIndex={0}
        data-record-id={record.id}
        aria-selected={selectedId === record.id}
        data-hidden={!hit || undefined}
        onClick={() => onSelect?.(record.id)}
        onKeyDown={handleKeyDown}
        className={cn(
          `relative grid min-h-[30px] cursor-default ${GRID} items-center gap-x-2.5 border-b border-border/40 transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring`,
          'hover:bg-surface-hover',
          selectedId === record.id && 'bg-primary-soft',
          focusIds && !focusIds.has(record.id) && 'opacity-[0.24]'
        )}
      >
        {selectedId === record.id && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 z-[5] w-[3px] bg-brand-indicator"
          />
        )}
        <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-faint">
          {record.seq !== undefined ? `#${record.seq}` : ''}
        </span>
        <span className="text-label tabular-nums tracking-[0.02em] text-foreground-faint">
          {record.at}
        </span>
        <span className="relative self-stretch">
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-1/2 top-0 w-px bg-border-strong"
          />
          <AxisNode kind={record.kind} status={record.status} />
        </span>
        <span
          className={cn(
            'flex min-w-0 items-center gap-2'
            /* 不缩进、也不加左边框：左边框会连带 pl-2 把文字推右 8px。
               注意可折叠行仍会因行首的 chevron（12px 图标 + 8px gap）比不可折叠行右移 20px——
               这是展开控件的固有代价，不是缩进；对齐的是「记录」列的左边界，不是行内首元素。 */
          )}
        >
          {collapsible && (
            <ChevronRight
              aria-hidden="true"
              onClick={handleToggleChildren}
              className={cn(
                'h-3 w-3 shrink-0 cursor-pointer text-foreground-faint transition-transform',
                childrenOpen && 'rotate-90'
              )}
              strokeWidth={1.4}
            />
          )}
          <KindChip record={record} />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px]',
              record.status === 'error' ? 'text-danger-text' : 'text-foreground-body',
              isChild && 'text-xs text-foreground-secondary',
              isEnd && 'text-xs text-foreground-muted'
            )}
          >
            {record.name !== undefined && (
              <span className="font-mono text-xs text-foreground-secondary">{record.name} </span>
            )}
            {record.target !== undefined && (
              <span className="text-xs text-foreground-muted">{record.target}</span>
            )}
            {/* 审批等待时长：与工具执行耗时分开，是这次调用的关键审计事实。
                紧凑格式（12 秒 / 3:12 / 2:07:33），否则长等待会撑爆「记录」列。 */}
            {record.waitMs !== undefined && (
              <span className="shrink-0 whitespace-nowrap text-xs text-foreground-muted">
                等待 {formatTrajectoryWait(record.waitMs)}
              </span>
            )}
            {/* 有工具名时默认不重复摘要；但审批行的摘要是「当时问了什么」，必须显示 */}
            {(record.name === undefined && record.target === undefined) ||
            record.waitMs !== undefined
              ? record.summary
              : null}
          </span>
        </span>
        {/* 窄容器下 token 列收窄到 122px：三段文本（最长约 157px）放不下，按"最不重要先让位"
            的同一原则整段隐去「缓」——它在窄列里本来也只会被截成省略号。缓存命中仍可在
            记录检查器里看到；`truncate` 保留为超大数字的最后兜底，避免右对齐溢出盖到「记录」列 */}
        <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-muted @max-[760px]:truncate">
          {record.tokens && (
            <>
              <span className="text-foreground-faint">入</span>{' '}
              {formatTrajectoryTokens(record.tokens.input)}
              <span className="text-foreground-faint"> · 出</span>{' '}
              {formatTrajectoryTokens(record.tokens.output)}
              <span className="@max-[760px]:hidden">
                <span className="text-foreground-faint"> · 缓</span>{' '}
                {formatTrajectoryTokens(record.tokens.cache)}
              </span>
            </>
          )}
          {record.totalTokens !== undefined && `${formatTrajectoryTokens(record.totalTokens)} tok`}
        </span>
        <span className="block @max-[760px]:hidden">
          <DurationBar ms={record.durationMs} tone={barTone} scaleMs={scaleMs} />
        </span>
        <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-muted">
          {record.status === 'running'
            ? '—'
            : isInstant
              ? ''
              : formatTrajectoryDuration(record.durationMs)}
        </span>
      </div>
      {childrenOpen && record.kind === 'call' && record.thinking !== undefined && (
        <OutputRow
          label="思考"
          text={record.thinking}
          callId={record.id}
          selectedId={selectedId}
          onSelect={onSelect}
          filterText={filterText}
        />
      )}
      {childrenOpen && record.kind === 'call' && record.reply !== undefined && (
        <OutputRow
          label="正文"
          text={record.reply}
          callId={record.id}
          selectedId={selectedId}
          onSelect={onSelect}
          filterText={filterText}
        />
      )}
      {/* 尝试明细只在**重试**（多于一次）时展开：1/1 是常态，展开只是重复调用行上的徽章 */}
      {childrenOpen &&
        record.kind === 'call' &&
        (record.attempts?.length ?? 0) > 1 &&
        record.attempts?.map((attempt) => (
          <AttemptRow
            key={attempt.id}
            attempt={attempt}
            seq={attempt.seq}
            scaleMs={scaleMs}
            selectedId={selectedId}
            onSelect={onSelect}
            filterText={filterText}
          />
        ))}
      {childrenOpen &&
        record.children?.map((c) => (
          <LedgerRow
            key={c.id}
            record={c}
            scaleMs={scaleMs}
            selectedId={selectedId}
            onSelect={onSelect}
            filterText={filterText}
            isChild
            focusIds={focusIds}
          />
        ))}
    </Fragment>
  )
}

/* ---------- 结束标记行 ---------- */

/**
 * 终态文案：wire 只带机制值（按触发者分类），文案在展示边界补。
 * interrupt 是 LLM 发起挂起，不是中断；crashed 才是进程遗留。
 *
 * 不复用 `trajectoryEndStateLabel`：记录表里 `crashed` 要说全（「已中断 · 进程中断」），
 * 单看「已中断」容易与 `interrupt` 的「等待用户」混淆，而两者的责任方根本不同。
 */
const END_STATE_LABEL: Record<TrajectoryTurnEnd['state'], string> = {
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  exhausted: '已耗尽',
  interrupt: '等待用户',
  crashed: '已中断 · 进程中断',
}

/**
 * 把终态标记合成为一条可渲染的 `turn-end` / `session-end` 记录。
 *
 * wire 上终态是轮次上的字段、不是记录；记录表按「行」渲染，所以在这里补出一个
 * 只有展示意义的记录壳。`seq` 缺省时不写该字段（而非写 0），避免显示假序号。
 *
 * @param kind - 记录类型：轮次结束或会话结束。
 * @param at - 结束时刻，HH:MM:SS。
 * @param seq - 全局稳定序号；undefined 表示未采集。
 * @param text - 行摘要文案（状态由 chip 承担，正文只讲发生了什么）。
 * @returns 供 EndRow 渲染的合成记录。
 */
function endRowRecord(
  kind: 'turn-end' | 'session-end',
  at: string,
  seq: number | undefined,
  text: string
): TrajectoryRecord {
  const rec: TrajectoryRecord = { id: `${kind}-${seq ?? 0}`, kind, at, summary: text }
  if (seq !== undefined) rec.seq = seq
  return rec
}

/* ---------- 压缩卡片 ---------- */

/** 压缩终态 → 展示文案；三态在压缩卡片里都要可辨（失败/中断时上下文未收缩）。 */
const CMP_STATUS_LABEL = { success: '成功', failed: '失败', interrupted: '已中断' } as const

/**
 * 压缩卡片：轮次之间的虚线卡片，展示 token 收缩的**对照事实**（压缩前 → 压缩后）、
 * 状态、被总结的消息数与释放量。
 *
 * 压缩不产出模型 token，所以它既不是记录也不是请求，而是轮次间的一等公民事件。
 * 失败 / 中断时 `afterTokens` 未收缩，卡片照实显示而不美化。
 *
 * @param props - 组件属性；字段语义见下方类型。
 */
function CompactionCard(props: {
  compaction: TrajectoryCompaction
  scaleMs: number
  selectedId: string | undefined
  onSelect: ((id: string) => void) | undefined
}) {
  const { compaction, scaleMs, selectedId, onSelect } = props
  const ratio = compaction.afterTokens / compaction.beforeTokens
  const released = compaction.beforeTokens - compaction.afterTokens
  const status = compaction.status ?? 'success'

  /** 键盘等价于点击：Enter / 空格选中这条压缩事件。 */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect?.(compaction.id)
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-selected={selectedId === compaction.id}
      onClick={() => onSelect?.(compaction.id)}
      onKeyDown={handleKeyDown}
      className={cn(
        `grid cursor-pointer ${GRID} items-center gap-x-2.5 py-2`,
        selectedId === compaction.id && 'bg-primary-soft'
      )}
    >
      <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-faint">
        {compaction.seq !== undefined ? `#${compaction.seq}` : ''}
      </span>
      <span className="text-label font-semibold tabular-nums text-foreground-secondary">
        {compaction.at}
      </span>
      <span className="relative self-stretch">
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-1/2 top-0 w-px bg-border-strong"
        />
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cat-cmp-indicator"
        />
      </span>
      <span className="block min-w-0 rounded-lg border border-dashed border-cat-cmp-indicator bg-cat-cmp-soft/55 px-3.5 py-2.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-xs font-semibold text-cat-cmp-text">上下文压缩</span>
          <span
            className={cn(
              'shrink-0 rounded-md px-[7px] py-[3px] text-label leading-none font-medium',
              status === 'success' && 'bg-success-bg text-success-text',
              status === 'failed' && 'bg-danger-bg text-danger-text',
              status === 'interrupted' && 'bg-muted text-foreground-muted'
            )}
          >
            {CMP_STATUS_LABEL[status]}
          </span>
          {/* 窄容器里先让说明文字退让截断：它与前两项都是 nowrap/逐字可断文本，
              不收窄就会把「上下文压缩」和状态 chip 压成竖排单字 */}
          <span className="whitespace-nowrap text-label text-foreground-faint @max-[760px]:min-w-0 @max-[760px]:truncate">
            轮次 {compaction.afterTurn} → {compaction.afterTurn + 1} 之间 · 自动触发
          </span>
        </span>
        <span className="mt-1 block text-label tabular-nums text-foreground-muted">
          总结 {compaction.messages} 条消息 · 释放 {formatTrajectoryTokens(released)} tok（−
          {((1 - ratio) * 100).toFixed(1)}%）
        </span>
        <span className="mt-1.5 grid max-w-[340px] gap-1">
          <span className="flex items-center gap-2 text-label tabular-nums text-foreground-faint">
            <span className="w-[118px] shrink-0">
              压缩前 {formatTrajectoryTokens(compaction.beforeTokens)} tok
            </span>
            <span className="relative h-1.5 flex-1 rounded-full bg-cat-cmp-indicator/15">
              <i className="absolute inset-y-0 left-0 w-full rounded-full bg-cat-cmp-indicator" />
            </span>
          </span>
          <span className="flex items-center gap-2 text-label tabular-nums text-foreground-faint">
            <span className="w-[118px] shrink-0">
              压缩后 {formatTrajectoryTokens(compaction.afterTokens)} tok
            </span>
            <span className="relative h-1.5 flex-1 rounded-full bg-cat-cmp-indicator/15">
              <i
                style={{ width: `${(ratio * 100).toFixed(1)}%` }}
                className="absolute inset-y-0 left-0 rounded-full bg-cat-cmp-indicator"
              />
            </span>
          </span>
        </span>
      </span>
      <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-muted">
        −{((1 - ratio) * 100).toFixed(1)}%
      </span>
      <span className="block @max-[760px]:hidden">
        <DurationBar ms={compaction.durationMs} tone="cmp" scaleMs={scaleMs} />
      </span>
      <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-muted">
        {formatTrajectoryDuration(compaction.durationMs)}
      </span>
    </div>
  )
}

/**
 * 找出含选中记录的轮次号；没有选中或找不到时返回 undefined。
 *
 * 选中项可能是记录本身，也可能是它的一条尝试（尝试与记录共用选中态，但 id 不同）。
 *
 * @param turns - 全部轮次。
 * @param selectedId - 当前选中的记录 / 尝试 id；undefined 表示无选中。
 * @returns 命中轮次的序号；无选中或未命中时 undefined（此时不画 turnRail）。
 */
function findActiveTurn(
  turns: TrajectoryTurn[],
  selectedId: string | undefined
): number | undefined {
  if (selectedId === undefined) return undefined
  for (const turn of turns) {
    const hit = turn.records.some(
      (r) => r.id === selectedId || (r.attempts ?? []).some((q) => q.id === selectedId)
    )
    if (hit) return turn.turn
  }
  return undefined
}

/**
 * 推导每轮之前的间隔项：压缩事件前后各一段空档，没有压缩时只剩等待用户的空档。
 *
 * 间隔不属于 wire 数据，是从轮次起止时刻与压缩时刻推导出的展示项；因此只对第 2 轮起
 * 生成（首轮之前没有前序）。
 *
 * @param turns - 全部轮次。
 * @param compaction - 会话级压缩事件；undefined 时只推导单段等待空档。
 * @returns 轮次号到该轮前间隔项列表的映射。
 */
function computeIntervalsBefore(
  turns: TrajectoryTurn[],
  compaction: TrajectoryCompaction | undefined
): Map<number, Array<{ kind: 'gap'; gap: TrajectoryGap } | { kind: 'cmp' }>> {
  const sec = (t: string) => trajectoryTimeToSeconds(t)

  /** 秒数格式化为 HH:MM:SS。 */
  function toHMS(s: number): string {
    /** 两位补零。 */
    function p(n: number): string {
      return String(n).padStart(2, '0')
    }
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(Math.floor(s % 60))}`
  }

  const map = new Map<number, Array<{ kind: 'gap'; gap: TrajectoryGap } | { kind: 'cmp' }>>()
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1]
    const cur = turns[i]
    if (!prev || !cur) continue
    const prevEnd = sec(prev.startedAt) + prev.durationMs / 1000
    const list: Array<{ kind: 'gap'; gap: TrajectoryGap } | { kind: 'cmp' }> = []
    const cmp = compaction && compaction.afterTurn === prev.turn ? compaction : undefined
    if (cmp) {
      const cmpAt = sec(cmp.at)
      list.push({
        kind: 'gap',
        gap: { seconds: cmpAt - prevEnd, from: toHMS(prevEnd), to: cmp.at, label: '会话空闲' },
      })
      list.push({ kind: 'cmp' })
      const cmpEnd = cmpAt + cmp.durationMs / 1000
      list.push({
        kind: 'gap',
        gap: {
          seconds: sec(cur.startedAt) - cmpEnd,
          from: toHMS(cmpEnd),
          to: cur.startedAt,
          label: '等待用户输入',
        },
      })
    } else {
      list.push({
        kind: 'gap',
        gap: {
          seconds: sec(cur.startedAt) - prevEnd,
          from: toHMS(prevEnd),
          to: cur.startedAt,
          label: '等待用户输入',
        },
      })
    }
    map.set(cur.turn, list)
  }
  return map
}

/* ---------- 轮次与主体 ---------- */

/**
 * 会话轨迹的轮次分组记录表：七列网格「# | 时刻 | 时间轴 | 记录 | token 入·出·缓 | 耗时条 | 时长」。
 * 轮次标题承载本轮合计；调用行可展开尝试明细；每轮尾部有终态标记；
 * 空档为全宽虚线 + pill 标签；压缩为轮次间的虚线对照卡片。
 *
 * 终态语义：只有 `endState` 有值才渲染「轮次 N 结束 · …」行；缺省表示该轮仍在流式进行中，
 * 此时标题行给出「进行中」标记，且标题「时长」只承诺已确认活动区间的下界、不是最终耗时。
 * 历史回放与流式投影共用同一份组件模型，用户必须能一眼区分「未终结」与「已终结」。
 *
 * 响应式：组件根节点是唯一的容器查询上下文；窄容器（检查器打开把记录表压窄时）让出「耗时条」列，
 * 保「记录」列可读——固定列不会让步，若不主动退让，被牺牲的必然是最重要的一列。
 *
 * @param props - 组件属性；字段语义见 `TrajectoryLedgerProps`。
 */
export function TrajectoryLedger(props: TrajectoryLedgerProps) {
  const {
    turns,
    compaction,
    sessionEnd,
    scaleMs,
    filterText,
    onFilterChange,
    selectedId,
    onSelect,
    focusIds,
  } = props
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set())
  /**
   * 请求级折叠：折叠某次调用的工具执行，收成一行 `… N 个工具调用 · name, name`。
   * 键是 call 记录的 id。
   */
  const [collapsedCalls, setCollapsedCalls] = useState<ReadonlySet<string>>(new Set())
  /** 当前轮次 = 含选中记录的轮次；turnRail 只画在它上面。 */
  const activeTurn = useMemo(() => findActiveTurn(turns, selectedId), [turns, selectedId])
  const scale = scaleMs ?? Math.max(...turns.map((t) => t.durationMs), 1)
  const query = filterText ?? ''

  /* 每轮之前的间隔项（空档 / 压缩 + 两侧空档），由轮次起止与压缩时刻推导 */
  const intervalsBefore = useMemo(
    () => computeIntervalsBefore(turns, compaction),
    [turns, compaction]
  )

  /** 展开全部：清空轮次与调用两级的折叠集合。 */
  function expandAll(): void {
    setCollapsedTurns(new Set())
    setCollapsedCalls(new Set())
  }

  /** 轮次标题行的键盘激活：等价于点击它（切换本轮折叠）。 */
  function handleTurnKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.currentTarget.click()
    }
  }

  /** 轮次标题里的 token 列：三段用量合计，未采集时退化为一个短横。 */
  function renderTurnUsage(turn: TrajectoryTurn): ReactElement | string {
    const usage = turnUsage(turn.records)
    if (usage === undefined) return '—'
    return (
      <>
        <span className="text-foreground-faint">入</span>
        {formatTrajectoryTokens(usage.input)}
        <span className="text-foreground-faint">·出</span>
        {formatTrajectoryTokens(usage.output)}
        <span className="text-foreground-faint">·缓</span>
        {formatTrajectoryTokens(usage.cache)}
      </>
    )
  }

  /** 渲染一轮：间隔带、轮次标题行、折叠摘要行与本轮全部记录。 */
  function renderTurn(turn: TrajectoryTurn, turnIndex: number): ReactElement {
    const collapsed = collapsedTurns.has(turn.turn)
    const children = turn.records.flatMap((r) => r.children ?? [])
    const toolCount = turn.records.filter((r) => r.kind === 'tool').length + children.length
    const errCount = [...turn.records, ...children].filter((r) => r.status === 'error').length
    const hasSub = turn.records.some((r) => r.kind === 'subagent')
    /* 轮次的首要计数单位是**请求**（一次用户提问会引发多次模型网关调用），
       「条记录」是拍平后的旧口径，与两级结构对不上。 */
    const requestCount = turn.records.filter((r) => r.kind === 'call').length
    const intervals = intervalsBefore.get(turn.turn) ?? []
    const items = groupRequests(turn.records)
    /* 被请求级折叠收走的系统执行：它们仍然与请求平级（语义不变），只是渲染时收进摘要行。
       用 id 集合跳过，而不是把工具挂进请求的子项——那会与「独立阶段」的模型冲突。 */
    const foldedSystemIds = new Set<string>()
    for (const item of items) {
      if (
        item.kind === 'request' &&
        item.callBlocks.length > 0 &&
        collapsedCalls.has(item.call.id)
      ) {
        for (const tool of item.callBlocks) foldedSystemIds.add(tool.id)
      }
    }

    /** 渲染本轮的一个阶段项：请求组、系统执行或普通记录。 */
    function renderTurnItem(item: TurnItem): ReactElement | null {
      if (item.kind === 'request') {
        return (
          <Fragment key={item.call.id}>
            <RequestHeaderRow
              index={item.index}
              call={item.call}
              toolCount={item.callBlocks.length}
              selectedId={selectedId}
              onSelect={onSelect}
              folded={item.callBlocks.length > 0 && collapsedCalls.has(item.call.id)}
              onToggleFold={
                item.callBlocks.length === 0
                  ? undefined
                  : () => setCollapsedCalls((prev) => toggleInSet(prev, item.call.id))
              }
            />
            {item.call.thinking !== undefined && (
              <OutputRow
                label="思考"
                text={item.call.thinking}
                callId={item.call.id}
                selectedId={selectedId}
                onSelect={onSelect}
                filterText={query}
              />
            )}
            {item.call.reply !== undefined && (
              <OutputRow
                label="正文"
                text={item.call.reply}
                callId={item.call.id}
                selectedId={selectedId}
                onSelect={onSelect}
                filterText={query}
              />
            )}
            {/* 工具调用是**模型写出的原始字符串**，属于本次请求的产出 */}
            {/* 请求级折叠摘要行：只说「有几个、叫什么」 */}
            {item.callBlocks.length > 0 && collapsedCalls.has(item.call.id) && (
              <div
                role="button"
                tabIndex={0}
                aria-expanded={false}
                onClick={() => setCollapsedCalls((prev) => removeFromSet(prev, item.call.id))}
                className={`grid min-h-[20px] cursor-pointer ${GRID} items-center gap-x-2.5 border-b border-border/40 text-label text-foreground-muted transition-colors hover:bg-surface-hover`}
              >
                <span />
                <span />
                <span className="relative self-stretch">
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-1/2 top-0 w-px bg-border-strong"
                  />
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className="text-foreground-faintest">
                    …
                  </span>
                  <span className="truncate">
                    {item.callBlocks.length} 个工具调用 ·{' '}
                    {item.callBlocks
                      .map((t) => t.name ?? '')
                      .filter((n) => n !== '')
                      .join(', ')}
                  </span>
                  <span className="shrink-0 text-foreground-faintest">（点此展开）</span>
                </span>
                <span />
                <span />
                <span />
              </div>
            )}
            {!collapsedCalls.has(item.call.id) &&
              item.callBlocks.map((tool) => (
                <OutputRow
                  key={`call-${tool.id}`}
                  label="工具调用"
                  text={toolCallText(tool)}
                  callId={item.call.id}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  filterText={query}
                />
              ))}
          </Fragment>
        )
      }
      if (item.kind === 'system-run') {
        /* 已被上方请求级折叠收进摘要行 → 这里不再单独渲染 */
        if (foldedSystemIds.has(item.record.id)) return null
        /* 系统执行是**独立阶段**，与请求平级：不缩进、也不加左边框。
           它「不产出模型 token」由 chip「工具执行」承担，不靠线条表达。 */
        return (
          <LedgerRow
            key={`sys-${item.record.id}`}
            record={item.record}
            scaleMs={scale}
            selectedId={selectedId}
            onSelect={onSelect}
            filterText={query}
            focusIds={focusIds}
          />
        )
      }
      return (
        <LedgerRow
          key={item.record.id}
          record={item.record}
          scaleMs={scale}
          selectedId={selectedId}
          onSelect={onSelect}
          filterText={query}
          focusIds={focusIds}
        />
      )
    }

    return (
      <Fragment key={turn.turn}>
        {intervals.map((item, i) =>
          item.kind === 'gap' ? (
            <GapBand key={`g${i}`} gap={item.gap} />
          ) : (
            compaction && (
              <CompactionCard
                key="cmp"
                compaction={compaction}
                scaleMs={scale}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            )
          )
        )}
        <div className="relative">
          {/* turnRail：2px、贯穿整轮，**只画在含选中记录的当前轮次**上；
              它不是「每轮一个装饰」，而是「你现在在哪一轮」的指示。 */}
          {activeTurn === turn.turn && (
            <span
              aria-hidden="true"
              className="trajectory-turn-rail pointer-events-none absolute bottom-0 left-0 top-[-1px] z-[4] w-0.5"
            />
          )}
          <div
            role="button"
            tabIndex={0}
            aria-expanded={!collapsed}
            onDoubleClick={() => setCollapsedTurns((prev) => toggleInSet(prev, turn.turn))}
            onClick={() => setCollapsedTurns((prev) => toggleInSet(prev, turn.turn))}
            onKeyDown={handleTurnKeyDown}
            /* **不 sticky**：轮次标题是记录流的一部分，随内容滚动（轮次标记只是
               行内角标）。只有工具栏与列头钉在顶部——多钉一层会让被穿过的行与它重叠，
               看起来像断层。 */
            className={`relative grid min-h-[42px] cursor-pointer select-none ${GRID} items-center gap-x-2.5 border-b border-border/40 bg-muted`}
          >
            {/* 轮次起线：2px、骑在行边界上、贯通整行。第一轮不画。 */}
            {turnIndex > 0 && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-0.5 -translate-y-1/2 bg-border/40"
              />
            )}
            <span />
            <span className="text-label font-semibold tabular-nums text-foreground-secondary">
              {turn.startedAt}
            </span>
            <span className="relative self-stretch">
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-1/2 top-0 w-px bg-border-strong"
              />
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-control-border bg-background"
              />
            </span>
            <span className="flex min-w-0 items-center gap-2.5">
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  'h-3 w-3 shrink-0 text-foreground-faint transition-transform',
                  !collapsed && 'rotate-90'
                )}
                strokeWidth={1.4}
              />
              <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-foreground">
                轮次 {turn.turn}
              </span>
              {/* meta / note 都是 nowrap 文本，不设收窄就会直接压到右侧 token 列上
                  （实测：长 note「上下文 8,100 tok 起（压缩后）」与「18,092 tok」重叠）。
                  所以**任何宽度**都要能截断，而不是只在窄容器下让位。 */}
              <span className="min-w-0 truncate whitespace-nowrap text-label text-foreground-faint">
                {requestCount} 个请求 · 工具 ×{toolCount}
                {hasSub ? ' · 子 Agent ×1' : ''}
                {errCount > 0 && <span className="text-danger-text"> · {errCount} 失败</span>}
              </span>
              {/* endState 缺省 = 该轮仍在流式进行中。没有这个标记时，「进行中」与
                  「已结束但没有终态」在记录表里外观完全一致，用户会误判会话已结束。 */}
              {turn.endState === undefined && (
                <span className="inline-flex h-[19px] shrink-0 items-center rounded-md bg-muted px-[5px] py-0 text-label leading-none font-semibold tracking-[0.035em] text-foreground-muted">
                  进行中
                </span>
              )}
              {turn.note && (
                <span className="min-w-0 truncate whitespace-nowrap text-label text-foreground-muted">
                  {turn.note}
                </span>
              )}
            </span>
            <span className="min-w-0 truncate whitespace-nowrap text-right text-label tabular-nums text-foreground-secondary">
              {renderTurnUsage(turn)}
            </span>
            <span className="block @max-[760px]:hidden">
              <DurationBar ms={turn.durationMs} tone="turn" scaleMs={scale} />
            </span>
            {/* 时长：未终结轮次显示的 durationMs 只是已知活动区间的下界（终态到达后才补齐最终耗时），
                数字格式不变，口径差异由标题行的「进行中」标记表达 */}
            <span className="whitespace-nowrap text-right text-label tabular-nums text-foreground-muted">
              {formatTrajectoryDuration(turn.durationMs)}
            </span>
          </div>
          {/* 折叠后插入 20px 摘要行：只说「有多少」，点它展开。
              摘要行占「记录」列，右侧 5 个数字列留空——否则七列会错位。 */}
          {collapsed && (
            <div
              role="button"
              tabIndex={0}
              aria-expanded={false}
              onClick={() => setCollapsedTurns((prev) => removeFromSet(prev, turn.turn))}
              className={`grid min-h-[20px] cursor-pointer ${GRID} items-center gap-x-2.5 border-b border-border/40 text-label text-foreground-muted transition-colors hover:bg-surface-hover`}
            >
              <span />
              <span />
              <span className="relative self-stretch">
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 left-1/2 top-0 w-px bg-border-strong"
                />
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden="true" className="text-foreground-faintest">
                  …
                </span>
                <span className="truncate">
                  {requestCount} 个请求 · 工具 ×{toolCount}
                </span>
                <span className="shrink-0 text-foreground-faintest">（点此展开）</span>
              </span>
              <span />
              <span />
              <span />
            </div>
          )}
          {!collapsed && (
            <>
              {items.map(renderTurnItem)}
              {turn.endState && (
                <EndRow
                  record={endRowRecord(
                    'turn-end',
                    turn.endState.at,
                    turn.endState.seq,
                    /* 状态由空心 chip 承担，正文不再重复它；note 保留（如失败原因） */
                    `轮次 ${turn.turn} 结束${turn.endState.note ? ` · ${turn.endState.note}` : ''}`
                  )}
                  state={turn.endState.state}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  filterText={query}
                />
              )}
            </>
          )}
        </div>
      </Fragment>
    )
  }

  return (
    <div role="table" aria-label="会话轨迹记录表" className="@container min-w-0">
      {/* 工具栏（32px）：折叠/展开全部 + 可选搜索框 */}
      <div className="sticky top-0 z-20 flex h-[32px] items-center gap-2 border-b border-border bg-background px-1.5">
        <button
          type="button"
          onClick={() => setCollapsedTurns(new Set(turns.map((t) => t.turn)))}
          className="inline-flex h-5 items-center gap-1 rounded-sm px-[7px] text-label text-foreground-secondary transition-colors hover:bg-surface-hover"
        >
          ⊟ 折叠全部
        </button>
        <button
          type="button"
          onClick={expandAll}
          className="inline-flex h-5 items-center gap-1 rounded-sm px-[7px] text-label text-foreground-secondary transition-colors hover:bg-surface-hover"
        >
          ⊞ 展开全部
        </button>
        {onFilterChange !== undefined && (
          <input
            value={query}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="搜索轨迹"
            aria-label="搜索轨迹"
            className="ml-auto h-[22px] w-[164px] shrink rounded-sm border border-control-border bg-background px-1.5 text-label text-foreground-body outline-none placeholder:text-foreground-faintest"
          />
        )}
      </div>
      <div
        className={`sticky top-[32px] z-10 grid h-[30px] ${GRID} items-center gap-x-2.5 border-b border-border bg-sidebar`}
      >
        <span className="text-right text-label font-medium text-foreground-faint">#</span>
        <span className="text-label font-medium text-foreground-faint">时刻</span>
        <span />
        <span className="text-label font-medium text-foreground-faint">记录</span>
        {/* 表头与数据列同口径：窄容器不承诺「缓」，避免表头承诺一个永远被截掉的列 */}
        <span className="text-right text-label text-foreground-faint">
          token 入 · 出<span className="@max-[760px]:hidden"> · 缓</span>
        </span>
        <span className="text-right text-label text-foreground-faint @max-[760px]:hidden">
          耗时
        </span>
        <span className="text-right text-label font-medium text-foreground-faint">时长</span>
      </div>

      {turns.map(renderTurn)}
      {sessionEnd && (
        <EndRow
          record={endRowRecord('session-end', sessionEnd.at, sessionEnd.seq, '会话结束')}
          state={sessionEnd.state}
          selectedId={selectedId}
          onSelect={onSelect}
          filterText={query}
        />
      )}
    </div>
  )
}

/**
 * 轮次间空档带：全宽虚线 + pill 标签。
 *
 * @param props - 组件属性；`gap` 提供空档秒数与起止时刻，标签说明在等什么。
 */
function GapBand(props: { gap: TrajectoryGap }) {
  const { gap } = props
  return (
    <div className={`relative grid min-h-[46px] ${GRID} items-center gap-x-2.5`}>
      <span />
      <span />
      <span className="relative self-stretch">
        <span
          aria-hidden="true"
          className="trajectory-gap-axis absolute bottom-0 left-1/2 top-0 w-px"
        />
      </span>
      <span className="relative flex min-w-0 items-center">
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-1/2 border-t border-dashed border-border-strong"
        />
        <span className="relative z-[1] mx-auto truncate rounded-full border border-border bg-background px-3.5 py-[3px] text-label leading-none text-foreground-muted">
          空档 {formatTrajectoryGap(gap.seconds)} · {gap.from} → {gap.to} · {gap.label}
        </span>
      </span>
      <span />
      {/* 占位对应「耗时条」列：窄模板下该列消失，这里同步隐藏，保持 6 个子元素对 6 列 */}
      <span className="@max-[760px]:hidden" />
      <span />
    </div>
  )
}
