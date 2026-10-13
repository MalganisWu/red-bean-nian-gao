import { memo } from 'react'
import { MessageCard } from '@/components/chat/MessageCard'
import { TaskResultCard } from '@/components/chat/TaskResultCard'
import { cn } from '@/lib/utils'
import type { CardSubmissionState, DisplayMessage } from '@/types/chat'
import type { QuestionCardAnswer } from '@/components/retroui/QuestionCard'

/** 单条消息渲染单元属性：消息本体、流式标志、卡片回调，以及定时任务结果是否最新。 */
interface ChatMessageItemProps {
  /** 待渲染的展示消息。 */
  message: DisplayMessage
  /** 本条消息是否仍在流式接收；决定进行中计时与折叠态。 */
  isStreaming?: boolean | undefined
  /**
   * pending 卡片确认回调；用户提交答案时触发。
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
  /** 本条消息是否为一轮的起点；用于轮次分隔与导航定位。 */
  startsRound?: boolean | undefined
  /** 本条定时任务结果是否为该任务的最新一次运行；最新结果默认保持展开。 */
  taskExecutionIsLatest?: boolean | undefined
}

/**
 * 单条消息的渲染单元；对列表项做 memo，避免流式增量导致整列重渲染。
 *
 * @param props - 单条消息及其交互回调；字段语义见 `ChatMessageItemProps`。
 */
export const ChatMessageItem = memo(function ChatMessageItem(props: ChatMessageItemProps) {
  const {
    message,
    isStreaming,
    onCardConfirm,
    onCardRefuse,
    cardSubmission,
    startsRound,
    taskExecutionIsLatest,
  } = props
  const isUser = message.role === 'user'
  // 定时任务结果 → TaskResultCard（source 判别；空 source = 普通对话走原渲染，不回归）
  const isTaskResult = message.source === 'scheduled_task'

  // 用户消息使用唯一的 muted 消息表面；Agent 回复继续裸排。
  if (isUser) {
    const time = new Date(message.timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    return (
      <div id={message.id} className={cn('py-1', startsRound && 'border-t border-border pt-9')}>
        <div className="mb-1.5 mr-1 flex items-center justify-end gap-1.5 text-xs text-foreground-muted">
          <span>你</span>
          <time dateTime={new Date(message.timestamp).toISOString()}>{time}</time>
        </div>
        <p className="ml-auto w-fit min-w-0 max-w-[78%] whitespace-pre-wrap rounded-lg bg-muted px-3.5 py-[11px] text-left font-sans text-sm font-medium leading-[1.65] text-foreground [overflow-wrap:anywhere] max-sm:max-w-[92%]">
          {message.content}
        </p>
      </div>
    )
  }

  return (
    <div id={message.id} className="py-1 text-left">
      {isTaskResult ? (
        <TaskResultCard message={message} isLatest={taskExecutionIsLatest} />
      ) : (
        <MessageCard
          content={message.content}
          sections={message.sections}
          isStreaming={isStreaming}
          meta={message.meta}
          onCardConfirm={onCardConfirm}
          onCardRefuse={onCardRefuse}
          cardSubmission={cardSubmission}
        />
      )}
    </div>
  )
})
