import { useEffect, useState } from 'react'
import { MarkdownAnswer } from '@/components/retroui/MarkdownAnswer'
import { QuestionCard } from '@/components/retroui/QuestionCard'
import { DelegationBlock } from '@/components/retroui/DelegationBlock'
import { ProcessFold, type ProcessStatus, type ProcessStep } from '@/components/retroui/ProcessFold'
import { normalizeSections } from './messageSections'
import { cn } from '@/lib/utils'
import { formatDurationMs, roundTotalDurationMs, toolDurationLabel } from './processSections'
import type {
  CardSectionData,
  CardSubmissionState,
  DisplayMessageMeta,
  MessageSection,
  ProcessStepItem,
  ReasonItem,
  SubAgentSectionData,
} from '@/types/chat'
import type { QuestionCardAnswer } from '@/components/retroui/QuestionCard'

/** MessageCard 的属性：正文 / sections 二者取一，外加流式标记、回合元信息、卡片确认回调与回合终态。 */
interface MessageCardProps {
  /** 纯文本正文；与 sections 二者取一，结构化消息走 sections。 */
  content?: string | undefined
  /** 结构化分段（思考、工具、卡片等）；优先于 content 渲染。 */
  sections?: MessageSection[] | undefined
  /** 是否仍在流式接收；决定进行中计时与折叠态。 */
  isStreaming?: boolean | undefined
  /** 回合元信息（run_started_at 用于历史回合总耗时重算） */
  meta?: DisplayMessageMeta | undefined
  /**
   * pending 卡片确认/拒绝回调（answer 调用由上层注入）
   * @param interactionId - 被确认卡片的交互 id；用于把答案路由回对应的询问。
   * @param answers - 用户提交的答案，按题目 id 索引；上层据此续跑对话流。
   */
  onCardConfirm?:
    ((interactionId: string, answers: Record<string, QuestionCardAnswer>) => void) | undefined
  /**
   * pending 卡片拒绝回调；用户拒绝作答时触发。
   * @param interactionId - 被拒绝卡片的交互 id；后端据此按拒绝处理该询问。
   */
  onCardRefuse?: ((interactionId: string) => void) | undefined
  /** 当前卡片的提交态；非空时卡片按 submitting/error 等状态渲染。 */
  cardSubmission?: CardSubmissionState | null | undefined
  /** 回合级显式终态；不能从单个 Tool/SubAgent failed 反推。 */
  terminalStatus?: 'completed' | 'failed' | 'cancelled' | undefined
}

/**
 * 判断一个子 Agent 委派是否被取消或未结束：自身状态为 cancelled / incomplete，
 * 或其后代 sections 中任意一处中断。
 *
 * @param subAgent - 子 Agent 段数据；`sections` 缺省时按空数组处理。
 * @returns 该委派是否处于中断态。
 */
function hasInterruptedSubAgent(subAgent: SubAgentSectionData): boolean {
  if (subAgent.status === 'cancelled' || subAgent.status === 'incomplete') return true
  return (subAgent.sections ?? []).some(isInterruptedSection)
}

/**
 * 单个 section 内是否有被取消或未结束的工具、推理步骤或子 Agent。
 *
 * @param section - 待检查的消息 section；只对 tool_group / reason / sub_agent / process 有意义。
 * @returns 该 section 是否含中断的工作；其余类型恒为 `false`。
 */
function isInterruptedSection(section: MessageSection): boolean {
  if (section.type === 'tool_group') {
    return section.tools.some((tool) => tool.status === 'cancelled' || tool.status === 'incomplete')
  }
  if (section.type === 'reason') {
    return section.items.some(
      (item) =>
        item.itemType === 'tool' &&
        (item.tool?.status === 'cancelled' || item.tool?.status === 'incomplete')
    )
  }
  if (section.type === 'sub_agent') {
    return hasInterruptedSubAgent(section.items)
  }
  if (section.type === 'process') return hasInterruptedWork(section.steps)
  return false
}

/**
 * 判断一组 Process 步骤中是否存在被取消或未结束的工作。
 *
 * @param steps - Process 步骤列表；逐个委托 `isInterruptedStep` 判定。
 * @returns 任意一步中断即返回 `true`。
 */
function hasInterruptedWork(steps: ProcessStepItem[]): boolean {
  return steps.some(isInterruptedStep)
}

/**
 * 单个 Process 步骤是否被取消或未结束（工具本身，或它挂载的子 Agent）。
 *
 * @param step - 单个过程步骤；工具中断看 `tool` 状态，委派中断看 `subAgent`。
 * @returns 该步骤是否处于中断态。
 */
function isInterruptedStep(step: ProcessStepItem): boolean {
  const interruptedTool =
    step.kind === 'tool' &&
    (step.tool?.status === 'cancelled' || step.tool?.status === 'incomplete')
  return interruptedTool || (step.subAgent ? hasInterruptedSubAgent(step.subAgent) : false)
}

/**
 * Quiet Tool 消息：一轮回合收束为「单一 Process + 最终回答」——
 * 思考、叙述、工具、子 Agent 与确认按时序进入同一条 Process 时间线。
 * 最终回答裸排 Markdown；只有 fenced code block 使用独立容器与复制动作。
 * 流式中折叠区默认展开 + 动态总耗时；回合结束自动收拢、总耗时定格（包络公式）。
 *
 * @param props - 组件属性；字段语义见 `MessageCardProps`。
 */
export function MessageCard(props: MessageCardProps) {
  const {
    content,
    sections,
    isStreaming,
    meta,
    onCardConfirm,
    onCardRefuse,
    cardSubmission,
    terminalStatus,
  } = props
  const normalized = sections ? normalizeSections(sections, { isStreaming }) : undefined

  // 流式中总耗时按整秒更新：从首个有效 section 时间戳起计（≈ 收到首个事件）
  const [now, setNow] = useState(() => Date.now())
  useEffect(tickNowWhileStreaming, [isStreaming])

  /** 流式期间每秒刷新一次 now，驱动总耗时按整秒跳动。 */
  function tickNowWhileStreaming(): (() => void) | undefined {
    if (!isStreaming) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }

  /** 本轮总耗时文案：流式中按 now 与起点实时算，结束后按包络公式定格。 */
  function computeTotalDuration(): string | undefined {
    if (!sections) return undefined
    if (isStreaming) {
      // 流式起点：meta.run_started_at = 前端发起本轮请求的时刻（含连接/鉴权等待），
      // 缺省回退到最早 section 时间戳（≈ 收到首个事件）。用这个锚才不会把 TTFB 那段丢掉
      const startAt = meta?.run_started_at ?? 0
      const anchor =
        startAt > 0 ? startAt : Math.min(...sections.map((s) => s.timestamp).filter((ts) => ts > 0))
      return Number.isFinite(anchor) ? formatDurationMs(Math.max(0, now - anchor)) : undefined
    }
    const total = roundTotalDurationMs(sections, meta)
    return total !== undefined ? formatDurationMs(total) : undefined
  }

  const totalDuration = computeTotalDuration()

  // 子 Agent 委派块：嵌套 sections 按主消息同规则收束——
  // process 步骤平铺为旁注 items（内层不再有自己的折叠区，spec §6.4），content 合并为最终输出
  /** 子 Agent 委派块：内层 sections 按主消息同规则收束为旁注 items 与最终输出。 */
  function renderDelegation(d: SubAgentSectionData): React.ReactElement {
    const inner = normalizeSections(d.sections ?? [], { isStreaming })
    const items: ReasonItem[] = []
    let output = ''
    for (const s of inner) {
      if (s.type === 'process') {
        for (const step of s.steps) {
          if (step.kind === 'tool' && step.tool)
            items.push({
              itemType: 'tool',
              tool: { ...step.tool, duration: toolDurationLabel(step.tool) },
            })
          else if (step.content) items.push({ itemType: 'step', content: step.content })
        }
      } else if (s.type === 'content') output += s.content
    }
    return (
      <DelegationBlock
        agentName={d.agent_name}
        status={d.status ?? 'completed'}
        items={items}
        output={output || undefined}
        summary={d.result_summary}
      />
    )
  }

  /** 确认卡片：按卡片状态与提交状态推导展示态与回调。 */
  function renderApproval(card: CardSectionData): React.ReactElement {
    const submission =
      cardSubmission?.interactionId === card.interaction_id ? cardSubmission : undefined
    const displayStatus =
      card.status === 'pending' && submission?.state === 'accepted'
        ? submission.refused
          ? 'refused'
          : 'answered'
        : card.status
    return (
      <QuestionCard
        questions={card.questions}
        status={displayStatus}
        answers={card.answers ?? submission?.answers ?? undefined}
        submitting={submission?.state === 'submitting'}
        disabled={Boolean(isStreaming && !submission)}
        error={submission?.state === 'error' ? submission.error : undefined}
        onConfirm={
          displayStatus === 'pending'
            ? (answers) => onCardConfirm?.(card.interaction_id, answers)
            : undefined
        }
        onRefuse={
          displayStatus === 'pending' ? () => onCardRefuse?.(card.interaction_id) : undefined
        }
      />
    )
  }

  /** 把一个过程步骤投影成 ProcessFold 的展示步骤（工具 / 委派 / 确认 / 叙述）。 */
  function toFoldStep(step: ProcessStepItem, active: boolean): ProcessStep {
    switch (step.kind) {
      case 'tool':
        return step.tool
          ? {
              kind: 'tool',
              tool: {
                ...step.tool,
                duration: toolDurationLabel(step.tool),
                defaultExpanded: step.tool.status === 'failed',
              },
              subAgent: step.subAgent ? renderDelegation(step.subAgent) : undefined,
              state:
                step.subAgent?.status === 'awaiting_user'
                  ? 'waiting'
                  : step.tool.status === 'running' || step.subAgent?.status === 'running'
                    ? 'active'
                    : 'complete',
            }
          : {
              kind: 'narration',
              content: '',
              state: active ? 'active' : 'complete',
            }
      case 'sub_agent':
        return step.subAgent
          ? {
              kind: 'sub_agent',
              subAgent: renderDelegation(step.subAgent),
              state:
                step.subAgent.status === 'awaiting_user'
                  ? 'waiting'
                  : step.subAgent.status === 'running'
                    ? 'active'
                    : 'complete',
            }
          : {
              kind: 'narration',
              content: '',
              state: active ? 'active' : 'complete',
            }
      case 'approval':
        return step.approval
          ? {
              kind: 'approval',
              approval: renderApproval(step.approval),
              state:
                step.approval.status === 'pending' &&
                !(
                  cardSubmission?.interactionId === step.approval.interaction_id &&
                  cardSubmission.state === 'accepted'
                )
                  ? 'waiting'
                  : 'complete',
            }
          : {
              kind: 'narration',
              content: '',
              state: active ? 'active' : 'complete',
            }
      case 'think':
      case 'narration':
        return {
          kind: step.kind,
          content: step.content,
          state: active ? 'active' : 'complete',
        }
    }
  }

  // 总耗时挂在唯一 Process 标签上（包络是整回合的）
  const lastProcessIdx = normalized?.map((s) => s.type).lastIndexOf('process') ?? -1

  /** 推断整条 Process 的展示状态：待确认 > 流式中 > 终态。 */
  function resolveProcessStatus(steps: ProcessStepItem[]): ProcessStatus {
    if (
      steps.some(
        (step) =>
          (step.kind === 'approval' &&
            step.approval?.status === 'pending' &&
            !(
              cardSubmission?.interactionId === step.approval.interaction_id &&
              cardSubmission.state === 'accepted'
            )) ||
          step.subAgent?.status === 'awaiting_user'
      )
    ) {
      return 'awaiting'
    }
    if (isStreaming) return 'running'
    if (terminalStatus === 'failed') return 'failed'
    if (
      terminalStatus === 'cancelled' ||
      meta?.process_status === 'cancelled' ||
      hasInterruptedWork(steps)
    )
      return 'cancelled'
    return 'completed'
  }

  /**
   * 渲染归一化后的单个 section：process 折叠区、最终正文或确认卡片。
   * 形参顺序对齐 `Array.prototype.map`，可直接作为其回调；`sections` 即被遍历的数组本身。
   */
  function renderSection(
    section: MessageSection,
    i: number,
    sections: MessageSection[]
  ): React.ReactNode {
    switch (section.type) {
      case 'process': {
        return (
          <ProcessFold
            key={i}
            steps={section.steps.map((step, si) =>
              toFoldStep(step, Boolean(isStreaming) && si === section.steps.length - 1)
            )}
            status={resolveProcessStatus(section.steps)}
            totalDuration={i === lastProcessIdx ? totalDuration : undefined}
          />
        )
      }
      case 'content': {
        const afterProcess = sections.slice(0, i).some((s) => s.type === 'process')
        return (
          <div key={i} className={cn(afterProcess && 'mt-5')}>
            <MarkdownAnswer content={section.content} />
          </div>
        )
      }
      case 'card':
        return <div key={i}>{renderApproval(section.card)}</div>
      case 'reason':
      case 'tool_group':
      case 'sub_agent':
        return null
    }
  }

  return (
    <div className="py-1">
      {normalized && normalized.length > 0
        ? // 线性渲染：单一 process → ProcessFold，最终 content → MarkdownAnswer。
          normalized.map(renderSection)
        : content && <MarkdownAnswer content={content} />}
    </div>
  )
}
