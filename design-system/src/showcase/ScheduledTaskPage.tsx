import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'

import { MarkdownAnswer } from '@/components/MarkdownAnswer'
import { Menu } from '@/components/Menu'
import { ProcessFold, type ProcessStep } from '@/components/ProcessFold'
import { ScheduledExecutionHeader } from '@/components/ScheduledExecutionHeader'
import { ScheduledTaskHeader } from '@/components/ScheduledTaskHeader'
import { ScheduledTaskHistory } from '@/components/ScheduledTaskHistory'
import { ScheduledTaskList } from '@/components/ScheduledTaskList'
import { ScheduledTaskOverview } from '@/components/ScheduledTaskOverview'
import type {
  ScheduledTaskDetailTab,
  ScheduledTaskFilter,
  ScheduledTaskListItemData,
  ScheduledTaskRunSummary,
} from '@/components/scheduledTaskTypes'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

type DemoView = 'list' | ScheduledTaskDetailTab | 'execution'

const TASKS: ScheduledTaskListItemData[] = [
  {
    id: 'order-sync',
    title: '订单同步异常巡检',
    source: '会话 · 订单数据排障',
    scheduleLabel: '每 30 分钟',
    nextRunLabel: '下次 今天 10:30',
    lifecycle: 'active',
    latestRun: {
      id: 'run-failed',
      status: 'failed',
      timeLabel: '今天 02:00',
      durationLabel: '31s',
      summary: '3 个订单源连续超时',
      unread: true,
    },
  },
  {
    id: 'daily-quality',
    title: '每日数据质量摘要',
    source: '会话 · 数据质量巡检',
    scheduleLabel: '每天 08:30',
    nextRunLabel: '下次 明天 08:30',
    lifecycle: 'active',
    latestRun: {
      id: 'run-success',
      status: 'completed',
      timeLabel: '今天 08:30',
      durationLabel: '19s',
      summary: '今天 08:31 · 19s',
    },
  },
  {
    id: 'weekly-product',
    title: '每周产品动态简报',
    source: '会话 · 产品情报',
    scheduleLabel: '每周一 09:00',
    nextRunLabel: '下次 9 月 1 日 09:00',
    lifecycle: 'active',
    latestRun: {
      id: 'run-weekly',
      status: 'completed',
      timeLabel: '8 月 25 日',
      durationLabel: '42s',
      summary: '8 月 25 日 · 42s',
    },
  },
  {
    id: 'monthly-archive',
    title: '月度归档提醒',
    source: '会话 · 团队行政',
    scheduleLabel: '每月最后一天 18:00',
    nextRunLabel: '暂停期间不执行',
    lifecycle: 'paused',
    latestRun: {
      id: 'run-archive',
      status: 'completed',
      timeLabel: '7 月 31 日',
      durationLabel: '9s',
      summary: '7 月 31 日 · 9s',
    },
  },
  {
    id: 'weekly-audit',
    title: '每周权限审计',
    source: '会话 · 安全检查',
    scheduleLabel: '每周五 18:00',
    nextRunLabel: '正在执行',
    lifecycle: 'active',
    latestRun: {
      id: 'run-running',
      status: 'running',
      timeLabel: '今天 18:00',
      summary: '正在读取权限变更记录',
    },
  },
  {
    id: 'one-time-reminder',
    title: '季度复盘提醒',
    source: '会话 · 团队计划',
    scheduleLabel: '单次 · 8 月 20 日 10:00',
    lifecycle: 'ended',
  },
]

const TASK_COUNTS: Record<ScheduledTaskFilter, number> = {
  all: TASKS.length,
  active: TASKS.filter((task) => task.lifecycle === 'active').length,
  attention: TASKS.filter((task) => task.latestRun?.status === 'failed').length,
  paused: TASKS.filter((task) => task.lifecycle === 'paused').length,
  ended: TASKS.filter((task) => task.lifecycle === 'ended').length,
}

const HISTORY: ScheduledTaskRunSummary[] = [
  {
    id: 'run-success',
    status: 'completed',
    timeLabel: '今天 08:30',
    durationLabel: '19s',
    summary: '今日数据质量整体稳定，重复率略有上升',
    meta: '计划 08:30 · 08:31 完成',
    unread: true,
    groupLabel: '今天',
  },
  {
    id: 'run-failed',
    status: 'failed',
    timeLabel: '今天 02:00',
    durationLabel: '31s',
    summary: '订单同步源连续超时，重试后仍未恢复',
    meta: '计划 02:00 · 02:01 结束',
    groupLabel: '今天',
  },
  {
    id: 'run-yesterday',
    status: 'completed',
    timeLabel: '8 月 27 日',
    durationLabel: '17s',
    summary: '全部指标处于正常区间',
    meta: '08:30 计划触发',
    groupLabel: '更早',
  },
  {
    id: 'run-before',
    status: 'completed',
    timeLabel: '8 月 26 日',
    durationLabel: '20s',
    summary: '及时性较昨日提升，未发现阻断问题',
    meta: '08:30 计划触发',
    groupLabel: '更早',
  },
]

function requiredExample<TValue>(value: TValue | undefined, label: string): TValue {
  if (value === undefined) throw new Error(`定时任务示例缺少${label}`)
  return value
}

const DEFAULT_TASK = requiredExample(TASKS[1], '默认任务')
const DEFAULT_RUN = requiredExample(HISTORY[0], '默认执行记录')

const PROCESS_STEPS: ProcessStep[] = [
  {
    kind: 'narration',
    content: '读取过去 24 小时的数据质量指标，先确认异常样本与昨日基线是否可比。',
    state: 'complete',
  },
  {
    kind: 'tool',
    state: 'complete',
    tool: {
      name: 'query_metrics',
      label: 'quality/daily · 2026-08-27',
      duration: '2s',
      status: 'success',
    },
  },
  {
    kind: 'narration',
    content: '完整率保持稳定；重复率连续两天上升，需要标出受影响来源并给出处理优先级。',
    state: 'complete',
  },
  {
    kind: 'tool',
    state: 'complete',
    tool: {
      name: 'compare_baseline',
      label: 'daily_quality · previous_7d',
      duration: '7s',
      status: 'success',
    },
  },
]

const SUCCESS_ANSWER = `## 今日数据质量整体稳定

过去 24 小时共检查 **126,840** 条记录，完整率与及时性均处于正常区间。

### 需要关注

- **重复率升至 2.3%**，较 7 日均值上升 0.7%。
- 异常主要来自订单同步源，集中在 02:10–02:35。
- 建议今天优先检查同步任务的重试与幂等逻辑。

目前不需要暂停下游任务；如果明日重复率仍高于 2%，再升级为告警。`

const FAILURE_ANSWER = `## 本次执行失败

订单同步源连续超时。系统已完成 2 次重试，但仍未取得可用数据，因此没有生成质量摘要。

建议先检查订单同步服务和网络状态，恢复后手动重新执行。`

function TaskActions({ active, title }: { active: boolean; title: string }) {
  return (
    <Menu>
      <Menu.Trigger
        aria-label={`${title}的更多操作`}
        className="grid h-9 w-9 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-foreground-muted hover:bg-surface-hover hover:text-foreground"
      >
        <MoreHorizontal aria-hidden="true" className="h-4 w-4" strokeWidth={1.5} />
      </Menu.Trigger>
      <Menu.Content className="p-1">
        <Menu.Item>{active ? '暂停任务' : '启用任务'}</Menu.Item>
        <Menu.Item className="text-danger focus:text-danger">删除任务</Menu.Item>
      </Menu.Content>
    </Menu>
  )
}

export function ScheduledTaskPage() {
  const [view, setView] = useState<DemoView>('list')
  const [filter, setFilter] = useState<ScheduledTaskFilter>('all')
  const [selectedTask, setSelectedTask] = useState<ScheduledTaskListItemData>(DEFAULT_TASK)
  const [selectedRun, setSelectedRun] = useState<ScheduledTaskRunSummary>(DEFAULT_RUN)

  function openTask(task: ScheduledTaskListItemData): void {
    setSelectedTask(task)
    setView('overview')
  }

  function openLatest(task: ScheduledTaskListItemData): void {
    setSelectedTask(task)
    const record = HISTORY.find((item) => item.id === task.latestRun?.id) ?? DEFAULT_RUN
    setSelectedRun(record)
    setView('execution')
  }

  function openExecution(record: ScheduledTaskRunSummary): void {
    setSelectedRun(record)
    setView('execution')
  }

  function changeDetailTab(tab: ScheduledTaskDetailTab): void {
    setView(tab)
  }

  const latestRun = selectedTask.latestRun ?? DEFAULT_RUN
  const failedExecution = selectedRun.status === 'failed'

  return (
    <div className="conversation-showcase">
      <SpecPageHeader
        title="定时任务 · Scheduled Tasks"
        description="任务列表负责扫描，任务概览负责定义，执行记录负责运行历史；三层共用状态语言但不重复内容。"
        note="Real components · 列表 / 概览 / 执行记录 / 单次执行 · Light / Dark"
      />

      <section className="spec-section">
        <h3 className="spec-section__title">Interactive reference</h3>
        <div className={view === 'list' ? 'mx-auto max-w-[920px]' : 'mx-auto max-w-[760px]'}>
          {view === 'list' && (
            <>
              <div className="mb-[26px] flex items-end justify-between gap-6 max-[700px]:flex-col max-[700px]:items-start max-[700px]:gap-2.5">
                <div>
                  <h4 className="m-0 font-sans text-[26px] font-semibold tracking-[-0.035em] text-foreground max-[700px]:text-[23px]">
                    定时任务
                  </h4>
                  <p className="mt-2 text-xs leading-[1.6] text-foreground-muted">
                    任务定义与运行结果分开呈现，先看需要处理的事情。
                  </p>
                </div>
                <span className="text-xs text-danger">1 个任务需要关注</span>
              </div>
              <ScheduledTaskList
                items={TASKS}
                filter={filter}
                filterCounts={TASK_COUNTS}
                onFilterChange={setFilter}
                onSelectTask={openTask}
                onSelectExecution={openLatest}
                onSort={() => undefined}
                renderActions={(task) => (
                  <TaskActions active={task.lifecycle === 'active'} title={task.title} />
                )}
              />
            </>
          )}

          {(view === 'overview' || view === 'history') && (
            <>
              <ScheduledTaskHeader
                title={selectedTask.title}
                source={selectedTask.source}
                kindLabel="周期任务"
                lifecycle={selectedTask.lifecycle}
                activeTab={view}
                historyCount={12}
                backLabel="全部任务"
                onBack={() => setView('list')}
                onTabChange={changeDetailTab}
                primaryAction={
                  <button
                    className="min-h-11 border-0 bg-transparent px-0 text-xs text-foreground-muted hover:text-foreground sm:min-h-0"
                    type="button"
                  >
                    {selectedTask.lifecycle === 'active' ? '暂停' : '启用'}
                  </button>
                }
                moreAction={
                  <TaskActions
                    active={selectedTask.lifecycle === 'active'}
                    title={selectedTask.title}
                  />
                }
              />
              {view === 'overview' ? (
                <ScheduledTaskOverview
                  scheduleLabel={selectedTask.scheduleLabel}
                  nextRunLabel={selectedTask.nextRunLabel ?? '—'}
                  nextRunTone={selectedTask.lifecycle === 'active' ? 'success' : 'muted'}
                  retryLabel="最多重试 2 次"
                  triggerLabel="计划自动触发"
                  cron="30 8 * * *"
                  instruction="读取过去 24 小时的数据质量指标，与近 7 日基线比较；如果发现异常，说明受影响的数据源、变化幅度与建议的处理优先级。"
                  latestRun={{
                    ...latestRun,
                    summary:
                      latestRun.status === 'failed'
                        ? '订单同步源连续超时，重试后仍未恢复。'
                        : '今日数据质量整体稳定，重复率较 7 日均值略有上升。',
                    meta: latestRun.status === 'failed' ? '结束于 10:01' : '完成于 08:31',
                  }}
                  onViewLatest={() => openLatest(selectedTask)}
                  onViewHistory={() => setView('history')}
                />
              ) : (
                <ScheduledTaskHistory
                  records={HISTORY}
                  onSelect={openExecution}
                  onSort={() => undefined}
                />
              )}
            </>
          )}

          {view === 'execution' && (
            <>
              <ScheduledExecutionHeader
                taskTitle={selectedTask.title}
                executionTitle={failedExecution ? '今天 02:00' : '今天 08:30'}
                status={selectedRun.status}
                durationLabel={selectedRun.durationLabel}
                triggerLabel="按计划自动触发"
                plannedLabel={failedExecution ? '02:00:00' : '08:30:00'}
                startedLabel={failedExecution ? '02:00:03' : '08:30:02'}
                completedLabel={failedExecution ? '02:00:34' : '08:30:20'}
                backLabel="执行记录"
                onBack={() => setView('history')}
              />
              <div className="mt-7">
                <ProcessFold
                  key={selectedRun.id}
                  status={failedExecution ? 'failed' : 'completed'}
                  totalDuration={selectedRun.durationLabel}
                  steps={
                    failedExecution
                      ? PROCESS_STEPS.map((step, index) =>
                          index === PROCESS_STEPS.length - 1 && step.tool
                            ? { ...step, tool: { ...step.tool, status: 'failed' as const } }
                            : step
                        )
                      : PROCESS_STEPS
                  }
                />
                <MarkdownAnswer content={failedExecution ? FAILURE_ANSWER : SUCCESS_ANSWER} />
              </div>
            </>
          )}
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">State model</h3>
        <div className="spec-rule-grid">
          <div>
            <strong>任务生命周期</strong>
            <p>启用使用成功绿；暂停与已结束使用中性灰。</p>
          </div>
          <div>
            <strong>执行结果</strong>
            <p>成功绿、失败鲜红、进行中灰色呼吸点；不改变任务生命周期。</p>
          </div>
          <div>
            <strong>需要关注</strong>
            <p>不是新状态；仅由“最近一次执行失败”派生。</p>
          </div>
          <div>
            <strong>未读</strong>
            <p>豆沙红小点只表达阅读状态，阅读后不等于问题已解决。</p>
          </div>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Loading / Empty / Error</h3>
        <div className="space-y-8">
          <ScheduledTaskList
            items={[]}
            loading
            filterCounts={{ all: 0, active: 0, attention: 0, paused: 0, ended: 0 }}
            onSelectTask={() => undefined}
          />
          <ScheduledTaskList
            items={[]}
            filterCounts={{ all: 0, active: 0, attention: 0, paused: 0, ended: 0 }}
            onSelectTask={() => undefined}
          />
          <ScheduledTaskList
            items={[]}
            error="暂时无法读取定时任务"
            onRetry={() => undefined}
            onSelectTask={() => undefined}
          />
          <div className="grid gap-8 lg:grid-cols-2">
            <ScheduledTaskHistory records={[]} loading onSelect={() => undefined} />
            <ScheduledTaskHistory records={[]} onSelect={() => undefined} />
            <ScheduledTaskHistory
              records={[]}
              error="暂时无法读取执行记录"
              onRetry={() => undefined}
              onSelect={() => undefined}
            />
            <ScheduledTaskHistory
              records={HISTORY.slice(0, 2)}
              hasMore
              onLoadMore={() => undefined}
              onSelect={() => undefined}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
