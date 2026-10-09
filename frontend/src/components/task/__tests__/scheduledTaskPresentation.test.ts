import { describe, expect, it } from 'vitest'

import {
  formatExecutionDuration,
  formatScheduleLabel,
  taskInstruction,
  taskTitle,
  toScheduledTaskLifecycle,
  toScheduledTaskListItem,
  toScheduledTaskRunSummary,
} from '../scheduledTaskPresentation'
import type { ExecutionViewState, Task, TaskExecution, TaskListItem } from '@/types/task'

const recurringTask: Task = {
  TaskID: 'task-1',
  SessionID: 'session-1',
  UserID: 'user-1',
  TaskInput: '每天检查订单同步状态',
  ScheduleType: 'recurring',
  CronExpr: '30 8 * * *',
  IsActive: true,
  RetryCount: 0,
  NextRunAt: '2026-08-29T08:30:00',
}

const failedExecution: TaskExecution = {
  ExecutionID: 'execution-1',
  TaskID: 'task-1',
  SessionID: 'session-1',
  Status: 'failed',
  ScheduledAt: '2026-08-28T08:30:00',
  StartedAt: '2026-08-28T08:30:02',
  CompletedAt: '2026-08-28T08:30:20.600',
  DisplayMessages: [],
  ResultType: null,
  ResultMessage: null,
  ErrorMessage: '**订单源** 连续超时\n\n请检查网络',
}

const unreadState: ExecutionViewState = {
  execution_id: 'execution-1',
  seen_at: null,
  collapsed_override: null,
  updated_at: null,
}

const recurringListItem: TaskListItem = {
  ...recurringTask,
  session_title: '订单运营',
  latest_execution: {
    ExecutionID: 'execution-1',
    Status: 'failed',
    ScheduledAt: '2026-08-28T08:30:00',
    StartedAt: '2026-08-28T08:30:02',
    CompletedAt: '2026-08-28T08:30:20.600',
    ResultMessage: null,
    ErrorMessage: '**订单源** 连续超时\n\n请检查网络',
  },
}

describe('scheduledTaskPresentation', () => {
  it('把常见 Cron 翻译成可扫读计划，未知 Cron 保留为周期任务', () => {
    expect(formatScheduleLabel(recurringTask)).toBe('每天 08:30')
    expect(formatScheduleLabel({ ...recurringTask, CronExpr: '*/30 * * * *' })).toBe('每 30 分钟')
    expect(formatScheduleLabel({ ...recurringTask, CronExpr: '0 9 * * 1' })).toBe('每周一 09:00')
    expect(formatScheduleLabel({ ...recurringTask, CronExpr: 'complex cron' })).toBe('周期任务')
  })

  it('区分启用、暂停与单次已结束，不把失败执行混入生命周期', () => {
    expect(toScheduledTaskLifecycle(recurringTask)).toBe('active')
    expect(toScheduledTaskLifecycle({ ...recurringTask, IsActive: false })).toBe('paused')
    expect(
      toScheduledTaskLifecycle({
        ...recurringTask,
        ScheduleType: 'once',
        CronExpr: '',
        IsActive: false,
      })
    ).toBe('ended')
  })

  it('从任务原始要求提取短标题；当前契约不虚构独立标题', () => {
    expect(taskTitle(recurringTask)).toBe('每天检查订单同步状态')
    expect(taskInstruction(recurringTask)).toBeUndefined()

    const multiline = { ...recurringTask, TaskInput: '订单巡检\n检查失败订单的同步状态' }
    expect(taskTitle(multiline)).toBe('订单巡检')
    expect(taskInstruction(multiline)).toBe('订单巡检\n检查失败订单的同步状态')
  })

  it('执行摘要去掉 Markdown、限制长度，并把未读与失败分别映射', () => {
    const summary = toScheduledTaskRunSummary(failedExecution, unreadState)
    expect(summary.status).toBe('failed')
    expect(summary.summary).toBe('订单源 连续超时 请检查网络')
    expect(summary.unread).toBe(true)
    expect(summary.durationLabel).toBe('18.6s')
  })

  it('把列表聚合的会话标题、最近执行和未读状态映射到展示模型', () => {
    const item = toScheduledTaskListItem(recurringListItem, unreadState)
    expect(item.source).toBe('会话 · 订单运营')
    expect(item.latestRun).toMatchObject({
      id: 'execution-1',
      status: 'failed',
      summary: '订单源 连续超时 请检查网络',
      unread: true,
    })
  })

  it('会话内任务列表可以隐藏重复的会话来源', () => {
    const item = toScheduledTaskListItem(recurringListItem, unreadState, {
      showSessionTitle: false,
    })
    expect(item.source).toBeUndefined()
  })

  it('列表没有执行摘要时不虚构运行状态', () => {
    const item = toScheduledTaskListItem({ ...recurringListItem, latest_execution: null })
    expect(item.latestRun).toBeUndefined()
  })

  it('无效或倒序时间不会显示负耗时', () => {
    expect(formatExecutionDuration('bad', 'also-bad')).toBeUndefined()
    expect(formatExecutionDuration('2026-08-28T08:31:00', '2026-08-28T08:30:00')).toBeUndefined()
  })
})
