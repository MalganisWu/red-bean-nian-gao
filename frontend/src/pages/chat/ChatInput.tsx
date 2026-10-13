import { ArrowRight, Square } from 'lucide-react'

/** 输入框属性：受控值 + 发送/取消回调；流式中或存在待答卡片时锁定输入。 */
interface ChatInputProps {
  /** 输入框的受控文本值。 */
  value: string
  /**
   * 文本变更时回调，由调用方更新受控值。
   * @param value - 输入框的最新文本；调用方据此更新受控值。
   */
  onChange: (value: string) => void
  /** 提交发送；回车（非 IME 组合中）与发送按钮都触发。 */
  onSend: () => void
  /** 取消当前流式；流式中展示为停止按钮。 */
  onCancel: () => void
  /** 是否正在流式；为 true 时输入框禁用、动作转为取消。 */
  isStreaming: boolean
  /** 存在待回答的询问卡片：锁普通消息（answer 是唯一解算者） */
  pending?: boolean
}

/**
 * Quiet Tool composer：固定在阅读列底部的单层输入框，透明按钮只靠文字/图标色区分。
 *
 * @param props - 组件属性；字段语义见 `ChatInputProps`。
 */
export function ChatInput(props: ChatInputProps) {
  const { value, onChange, onSend, onCancel, isStreaming, pending } = props
  function handleKeyDown(e: React.KeyboardEvent) {
    // IME 组合输入中（中文输入法按回车确认候选词）不提交，避免没打完就发出
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className="border-t border-border bg-background px-6 pb-[18px] pt-3.5 max-[760px]:px-3 max-[760px]:pb-3 max-[760px]:pt-2.5">
      <div className="mx-auto grid w-full max-w-[760px] grid-cols-[minmax(0,1fr)_34px] items-end gap-2 rounded-xl border border-control-border bg-background px-2 py-[7px] shadow-[var(--shadow-composer)] transition-colors focus-within:border-brand-text focus-within:ring-2 focus-within:ring-focus-ring focus-within:ring-offset-1 focus-within:ring-offset-background">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={pending ? '请先回答上方的询问…' : '继续回复…'}
          disabled={isStreaming || pending}
          rows={1}
          aria-label="消息"
          className="min-h-[34px] max-h-[100px] w-full resize-none bg-transparent px-0.5 pb-[5px] pt-[7px] font-sans text-[13.5px] leading-[1.5] text-foreground caret-primary placeholder:text-foreground-muted focus:outline-none disabled:opacity-45"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onCancel}
            aria-label="停止生成"
            className="grid h-[34px] w-[34px] cursor-pointer place-items-center rounded-lg bg-transparent text-danger transition-colors hover:bg-danger-bg"
          >
            <Square className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={pending || !value.trim()}
            aria-label="发送"
            className="grid h-[34px] w-[34px] cursor-pointer place-items-center rounded-lg bg-transparent text-primary transition-colors hover:bg-primary-soft hover:text-primary-hover disabled:cursor-not-allowed disabled:text-foreground-faint"
          >
            <ArrowRight className="h-[18px] w-[18px]" strokeWidth={1.45} />
          </button>
        )}
      </div>
    </div>
  )
}
