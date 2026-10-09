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

interface MessageCardProps {
  content?: string | undefined
  sections?: MessageSection[] | undefined
  isStreaming?: boolean | undefined
  /** 回合元信息（run_started_at 用于历史回合总耗时重算） */
  meta?: DisplayMessageMeta | undefined
  /** pending 卡片确认/拒绝回调（answer 调用由上层注入） */
  onCardConfirm?:
    ((interactionId: string, answers: Record<string, QuestionCardAnswer>) => void) | undefined
  onCardRefuse?: ((interactionId: string) => void) | undefined
  cardSubmission?: CardSubmissionState | null | undefined
  /** 回合级显式终态；不能从单个 Tool/SubAgent failed 反推。 */
  terminalStatus?: 'completed' | 'failed' | 'cancelled' | undefined
}

function hasInterruptedSubAgent(subAgent: SubAgentSectionData): boolean {
  if (subAgent.status === 'cancelled' || subAgent.status === 'incomplete') return true
  return (subAgent.sections ?? []).some((section) => {
    if (section.type === 'tool_group') {
      return section.tools.some(
        (tool) => tool.status === 'cancelled' || tool.status === 'incomplete'
      )
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
  })
}

function hasInterruptedWork(steps: ProcessStepItem[]): boolean {
  return steps.some((step) => {
    const interruptedTool =
      step.kind === 'tool' &&
      (step.tool?.status === 'cancelled' || step.tool?.status === 'incomplete')
    return interruptedTool || (step.subAgent ? hasInterruptedSubAgent(step.subAgent) : false)
  })
}

/**
 * Quiet Tool 消息：一轮回合收束为「单一 Process + 最终回答」——
 * 思考、叙述、工具、子 Agent 与确认按时序进入同一条 Process 时间线。
 * 最终回答裸排 Markdown；只有 fenced code block 使用独立容器与复制动作。
 * 流式中折叠区默认展开 + 动态总耗时；回合结束自动收拢、总耗时定格（包络公式）。
 */
export function MessageCard({
  content,
  sections,
  isStreaming,
  meta,
  onCardConfirm,
  onCardRefuse,
  cardSubmission,
  terminalStatus,
}: MessageCardProps) {
  const normalized = sections ? normalizeSections(sections, { isStreaming }) : undefined

  // 流式中总耗时按整秒更新：从首个有效 section 时间戳起计（≈ 收到首个事件）
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isStreaming) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isStreaming])

  const totalDuration = (() => {
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
  })()

  // 子 Agent 委派块：嵌套 sections 按主消息同规则收束——
  // process 步骤平铺为旁注 items（内层不再有自己的折叠区，spec §6.4），content 合并为最终输出
  const renderDelegation = (d: SubAgentSectionData) => {
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

  const renderApproval = (card: CardSectionData) => {
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

  const toFoldStep = (step: ProcessStepItem, active: boolean): ProcessStep => {
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

  const resolveProcessStatus = (steps: ProcessStepItem[]): ProcessStatus => {
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

  return (
    <div className="py-1">
      {normalized && normalized.length > 0
        ? // 线性渲染：单一 process → ProcessFold，最终 content → MarkdownAnswer。
          normalized.map((section, i) => {
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
                const afterProcess = normalized.slice(0, i).some((s) => s.type === 'process')
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
          })
        : content && <MarkdownAnswer content={content} />}
    </div>
  )
}
