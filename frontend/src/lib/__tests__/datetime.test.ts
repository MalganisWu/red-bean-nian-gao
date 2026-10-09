import { describe, it, expect } from 'vitest'
import { formatShortDateTime, formatDateTime, isAbsentTime } from '@/lib/datetime'

describe('formatShortDateTime 短日期时间（MM-DD HH:mm）', () => {
  it('空时间返回 fallback', () => {
    expect(formatShortDateTime(undefined)).toBe('—')
    expect(formatShortDateTime(null)).toBe('—')
    expect(formatShortDateTime('')).toBe('—')
  })

  it('自定义 fallback', () => {
    expect(formatShortDateTime(undefined, '无')).toBe('无')
  })

  it('格式化为 MM-DD HH:mm（补零）', () => {
    const d = new Date(2026, 7, 26, 9, 12) // 本地时间 2026-08-26 09:12
    expect(formatShortDateTime(d.toISOString())).toBe('08-26 09:12')
  })

  it('单位数月/日/时/分均补零', () => {
    const d = new Date(2026, 0, 5, 8, 3) // 2026-01-05 08:03
    expect(formatShortDateTime(d.toISOString())).toBe('01-05 08:03')
  })
})

describe('既有行为回归', () => {
  it('isAbsentTime / formatDateTime 不变', () => {
    expect(isAbsentTime(undefined)).toBe(true)
    expect(isAbsentTime(null)).toBe(true)
    expect(isAbsentTime('')).toBe(true)
    expect(isAbsentTime('2026-08-26T09:12:00Z')).toBe(false)
    expect(formatDateTime(undefined, '待调度')).toBe('待调度')
  })
})
