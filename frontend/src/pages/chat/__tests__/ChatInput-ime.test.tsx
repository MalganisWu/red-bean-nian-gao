import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { ChatInput } from '../ChatInput'

describe('ChatInput IME 组合输入', () => {
  it('IME 组合中按 Enter 不提交（避免没打完就发出）', () => {
    const onSend = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={onSend}
        onCancel={() => {}}
        isStreaming={false}
      />
    )
    const input = screen.getByPlaceholderText('继续回复…')

    // 模拟中文输入法组合状态：isComposing=true
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'isComposing', { get: () => true })
    fireEvent(input, ev)

    expect(onSend).not.toHaveBeenCalled()
  })

  it('非组合（直接输入）Enter 正常提交', () => {
    const onSend = vi.fn()
    render(
      <ChatInput
        value="你好"
        onChange={() => {}}
        onSend={onSend}
        onCancel={() => {}}
        isStreaming={false}
      />
    )
    fireEvent.keyDown(screen.getByPlaceholderText('继续回复…'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalled()
  })

  it('⇧⏎ 换行不提交', () => {
    const onSend = vi.fn()
    render(
      <ChatInput
        value="你好"
        onChange={() => {}}
        onSend={onSend}
        onCancel={() => {}}
        isStreaming={false}
      />
    )
    fireEvent.keyDown(screen.getByPlaceholderText('继续回复…'), { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('流式中显示停止按钮，点击触发 onCancel', () => {
    const onCancel = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        onCancel={onCancel}
        isStreaming={true}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /停止/ }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('pending 时锁定输入并提示先回答询问', () => {
    render(
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        onCancel={() => {}}
        isStreaming={false}
        pending
      />
    )
    const input = screen.getByPlaceholderText('请先回答上方的询问…')
    expect(input).toBeDisabled()
  })
})
