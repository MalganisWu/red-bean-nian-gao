import { memo } from 'react'
import { MessageCard } from '@/components/chat/MessageCard'
import { TaskResultCard } from '@/components/chat/TaskResultCard'
import { cn } from '@/lib/utils'
import type { CardSubmissionState, DisplayMessage } from '@/types/chat'
import type { QuestionCardAnswer } from '@/components/retroui/QuestionCard'

interface ChatMessageItemProps {
  message: DisplayMessage
  isStreaming?: boolean | undefined
  onCardConfirm?:
    ((interactionId: string, answers: Record<string, QuestionCardAnswer>) => void) | undefined
  onCardRefuse?: ((interactionId: string) => void) | undefined
  cardSubmission?: CardSubmissionState | null | undefined
  startsRound?: boolean | undefined
  taskExecutionIsLatest?: boolean | undefined
}

export const ChatMessageItem = memo(function ChatMessageItem({
  message,
  isStreaming,
  onCardConfirm,
  onCardRefuse,
  cardSubmission,
  startsRound,
  taskExecutionIsLatest,
}: ChatMessageItemProps) {
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
