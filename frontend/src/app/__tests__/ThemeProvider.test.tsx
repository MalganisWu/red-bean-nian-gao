import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from '@/app/ThemeProvider'
import { ThemeToggle } from '@/components/layout/ThemeToggle'

describe('Quiet Tool 主题', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.classList.remove('dark')
    document.documentElement.style.colorScheme = ''
  })

  it('默认使用浅色，并把根节点与持久化状态一起切换为深色', () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    )

    const toggle = screen.getByRole('button', { name: '切换到深色模式' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(document.documentElement).not.toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('light')

    fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: '切换到浅色模式' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(document.documentElement).toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(window.localStorage.getItem('rbng-theme')).toBe('dark')
  })

  it('重载时恢复已持久化的深色主题', () => {
    window.localStorage.setItem('rbng-theme', 'dark')

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    )

    expect(screen.getByRole('button', { name: '切换到浅色模式' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(document.documentElement).toHaveClass('dark')
  })
})
