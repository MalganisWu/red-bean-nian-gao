import { describe, it, expect } from 'vitest'
import { AppError, extractErrorMessage } from '../errors'

describe('extractErrorMessage', () => {
  it('AppError 返回其用户可读消息', () => {
    expect(extractErrorMessage(new AppError('登录已过期', 401, 4002))).toBe('登录已过期')
  })

  it('普通 Error 返回其 message', () => {
    expect(extractErrorMessage(new Error('网络中断'))).toBe('网络中断')
  })

  it('非 Error 值回退到兜底文案', () => {
    expect(extractErrorMessage('boom')).toBe('请求失败，请稍后重试')
    expect(extractErrorMessage(null)).toBe('请求失败，请稍后重试')
    expect(extractErrorMessage(undefined)).toBe('请求失败，请稍后重试')
  })
})
