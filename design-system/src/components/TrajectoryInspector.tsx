'use client'

import { useState } from 'react'

import { cn } from '../lib/utils'
import {
  formatTrajectoryDuration,
  formatTrajectoryTokens,
  type TrajectoryCompaction,
  type TrajectoryRecord,
  type TrajectoryAttempt,
} from './trajectoryTypes'

/** 轨迹详情面板的 Props；`record` / `compaction` / `request` 三者互斥（后两者是压缩事件与尝试明细）。 */
export interface TrajectoryInspectorProps {
  /** 当前选中的记录；null 时不渲染（由消费方决定挂载与否）。 */
  record: TrajectoryRecord | undefined
  /** 选中的压缩事件（与 record 互斥，压缩是回合间事件）。 */
  compaction?: TrajectoryCompaction | undefined
  /** 选中的尝试明细（与 record 互斥；尝试是 call 的子行，不是独立记录）。 */
  request?: TrajectoryAttempt | undefined
  /** 所属轮次标签（如「轮次 2」），由消费方解析。 */
  turnLabel?: string | undefined
  /** 打开时希望停留的 tab（点产出行时由调用方给出）；缺省用第一个可用 tab。 */
  initialTab?: string | undefined
  /** 定位/布局类名由调用方给（覆盖式：`absolute inset-y-0 right-0 z-20`）。 */
  className?: string | undefined
  /** 步骤概览里点击某次 LLM 请求时回调（用于跳转到请求详情）。 */
  onSelectRecord?: ((id: string) => void) | undefined
  onClose: () => void
}

function KV({ pairs }: { pairs: readonly [string, React.ReactNode][] }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-xs">
      {pairs.map(([k, v]) => (
        <div key={k} className="contents">
          <span className="text-foreground-faint">{k}</span>
          <span className="min-w-0 text-foreground-body">{v}</span>
        </div>
      ))}
    </div>
  )
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <div className="text-label text-foreground-faint">{label}</div>
      <div className="mt-0.5 text-base font-semibold tabular-nums text-foreground">{value}</div>
      {sub && <div className="mt-0.5 text-label text-foreground-muted">{sub}</div>}
    </div>
  )
}

/**
 * 轨迹记录检查器：右侧常驻栏，按记录类型分 tab 展示完整内容。
 * 用户=内容；步骤=思考/输出/概览；工具=参数/结果/概览；子 Agent=概览/结果/内部调用；
 * 压缩=前后对照与策略说明。
 */
export function TrajectoryInspector({
  record,
  compaction,
  request,
  turnLabel,
  initialTab,
  className,
  onSelectRecord,
  onClose,
}: TrajectoryInspectorProps) {
  const target = record ?? compaction ?? request
  const tabs: string[] =
    record?.kind === 'user'
      ? ['内容']
      : record?.kind === 'call'
        ? [...(record.thinking ? ['思考'] : []), ...(record.reply ? ['正文'] : []), '概览']
        : record?.kind === 'tool'
          ? ['参数', '结果', '概览']
          : record?.kind === 'subagent'
            ? ['概览', '结果']
            : request
              ? ['概览']
              : compaction
                ? ['概览']
                : []
  const [activeTab, setActiveTab] = useState<string | undefined>(undefined)
  /**
   * tab 跨记录记忆：用户点过一次「概览」后，再点别的记录仍停在
   * 「概览」，而不是每次弹回第一个可用 tab。
   *
   * 用 state 而不是 ref：它参与 `currentTab` 的解析、会影响渲染，而 **React 禁止在渲染期读 ref**
   * （`react-hooks` 规则会直接报错）。记忆是「用户上一次的选择」，用 state 表达也更准确。
   */
  const [rememberedTab, setRememberedTab] = useState<string | undefined>(undefined)
  /* 用户在面板内点过 tab 就听用户的；否则用调用方指定的 initialTab（点「正文」直接看正文）；
     都没有才回落到第一个可用 tab。 */
  /* 优先级：面板内主动点过的 → 调用方指定的（点产出行）→ 上次记住的 → 第一个可用 */
  const currentTab =
    activeTab && tabs.includes(activeTab)
      ? activeTab
      : initialTab !== undefined && tabs.includes(initialTab)
        ? initialTab
        : rememberedTab !== undefined && tabs.includes(rememberedTab)
          ? rememberedTab
          : tabs[0]

  if (!target) return null

  const title =
    record?.kind === 'user'
      ? `${record.at} · 用户消息`
      : record?.kind === 'call'
        ? `${record.at} · LLM 调用`
        : record?.kind === 'tool'
          ? `${record.at} · 工具 ${record.name ?? ''}`
          : record?.kind === 'subagent'
            ? `${record.at} · 子 Agent ${record.name ?? ''}`
            : request
              ? `LLM 请求 · 尝试 ${request.attempt}`
              : compaction
                ? `${compaction.at} · 上下文压缩`
                : ''

  return (
    <aside
      aria-label="记录检查器"
      /*
       * 覆盖式窗格（不是挤压式）：调用方把它绝对定位在表格容器右侧，表格宽度不受影响。
       * 宽 clamp(320px,38%,440px) + max-w-[calc(100%-280px)]（保证表格永远留 ≥280px），
       * 顶部贴容器、无圆角、**无投影**——它是「贴在右侧的一块面」，不是浮空卡片；
       * 边界只由 1px 左边框承担。
       */
      className={cn(
        'flex h-full flex-col border-l border-border bg-background',
        'w-[clamp(320px,38%,440px)] max-w-[calc(100%-280px)]',
        className
      )}
    >
      <div className="flex h-[42px] shrink-0 items-center justify-between gap-2 border-b border-border pl-3 pr-2">
        <span className="truncate text-[13px] font-medium text-foreground">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭检查器"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-base text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          ×
        </button>
      </div>
      <div
        role="tablist"
        aria-label="记录详情分区"
        className="flex h-[34px] shrink-0 items-center gap-px border-b border-border px-2"
      >
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={currentTab === t}
            onClick={() => {
              setActiveTab(t)
              setRememberedTab(t)
            }}
            className={cn(
              'relative h-full px-[9px] text-[13px] transition-colors',
              'after:absolute after:inset-x-[9px] after:bottom-0 after:h-0.5 after:rounded-t-[1px]',
              currentTab === t
                ? 'text-foreground after:bg-brand-indicator'
                : 'text-foreground-muted after:bg-transparent hover:text-foreground'
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="flex-1 overflow-y-auto p-4 text-[13px]">
        {record?.kind === 'user' && currentTab === '内容' && (
          <>
            <div className="mb-4">
              <div className="mb-1 text-label text-foreground-faint">完整消息</div>
              <div className="whitespace-pre-wrap break-words text-foreground-body">
                {record.summary}
              </div>
            </div>
            <KV
              pairs={[
                ['发送时间', record.at],
                ['所属轮次', turnLabel ?? '—'],
              ]}
            />
          </>
        )}

        {record?.kind === 'call' && currentTab === '思考' && (
          <div className="whitespace-pre-wrap break-words text-foreground-body">
            {record.thinking}
          </div>
        )}
        {record?.kind === 'call' && currentTab === '正文' && (
          <div className="whitespace-pre-wrap break-words text-foreground-body">{record.reply}</div>
        )}
        {record?.kind === 'call' && currentTab === '概览' && (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              <Metric
                label="输入 token"
                value={formatTrajectoryTokens(record.tokens?.input ?? 0)}
              />
              <Metric
                label="输出 token"
                value={formatTrajectoryTokens(record.tokens?.output ?? 0)}
              />
              <Metric
                label="缓存命中"
                value={formatTrajectoryTokens(record.tokens?.cache ?? 0)}
                sub={
                  record.tokens?.input
                    ? `占输入 ${(((record.tokens.cache ?? 0) / record.tokens.input) * 100).toFixed(0)}%`
                    : undefined
                }
              />
              <Metric label="模型" value={record.model ?? record.attempts?.at(-1)?.model ?? '—'} />
              <Metric label="调用耗时" value={formatTrajectoryDuration(record.durationMs)} />
            </div>
            <div className="mt-3">
              <KV
                pairs={[
                  ['开始时刻', record.at],
                  ['所属轮次', turnLabel ?? '—'],
                ]}
              />
            </div>
            {(record.attempts?.length ?? 0) > 0 && (
              <div className="mt-3.5">
                <div className="mb-1 text-label text-foreground-faint">
                  本次调用的尝试（{record.attempts?.length} 次
                  {(record.attempts?.length ?? 0) > 1
                    ? ` · 重试 ${(record.attempts?.length ?? 1) - 1} 次`
                    : ''}
                  ）
                </div>
                <div className="grid gap-1.5">
                  {record.attempts?.map((req, i, all) => {
                    /* 非最后一次的失败 = 这次失败**触发了重试**，把原因显式说出来；
                       最后一次失败就是这次调用最终失败，不带「触发重试」。 */
                    const triggeredRetry = req.status === 'error' && i < all.length - 1
                    return (
                      <button
                        key={req.id}
                        type="button"
                        onClick={() => onSelectRecord?.(req.id)}
                        className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-left text-xs text-foreground-body transition-colors hover:bg-surface-hover"
                      >
                        <span className="font-mono">{req.model}</span>
                        <span className="shrink-0 text-foreground-faint">尝试 {req.attempt}</span>
                        {req.status === 'error' ? (
                          <span className="min-w-0 truncate text-danger-text">
                            {req.error ?? '失败（未记录原因）'}
                          </span>
                        ) : (
                          <span className="shrink-0 text-foreground-faint">
                            入 {formatTrajectoryTokens(req.tokens?.input ?? 0)} · 出{' '}
                            {formatTrajectoryTokens(req.tokens?.output ?? 0)}
                          </span>
                        )}
                        {triggeredRetry && (
                          <span className="shrink-0 text-label text-foreground-muted">
                            → 触发重试
                          </span>
                        )}
                        <span className="ml-auto shrink-0 text-label tabular-nums text-foreground-faint">
                          {formatTrajectoryDuration(req.durationMs)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {record?.kind === 'tool' && currentTab === '参数' && (
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2.5 font-mono text-xs text-foreground-body">
            {record.params}
          </pre>
        )}
        {record?.kind === 'tool' && currentTab === '结果' && (
          <pre
            className={cn(
              'whitespace-pre-wrap break-words rounded-lg px-3 py-2.5 font-mono text-xs',
              record.status === 'error' ? 'text-danger-text' : 'bg-muted text-foreground-body'
            )}
          >
            {record.result}
          </pre>
        )}
        {record?.kind === 'tool' && currentTab === '概览' && (
          <KV
            pairs={[
              [
                '工具',
                <span key="n" className="font-mono">
                  {record.name}
                </span>,
              ],
              [
                '状态',
                record.status === 'error' ? (
                  <span key="e" className="text-danger-text">
                    失败
                  </span>
                ) : (
                  <span key="s" className="text-success-text">
                    成功
                  </span>
                ),
              ],
              ['耗时', formatTrajectoryDuration(record.durationMs)],
              ['开始时刻', record.at],
              ['所属轮次', turnLabel ?? '—'],
            ]}
          />
        )}

        {record?.kind === 'subagent' && currentTab === '概览' && (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              <Metric
                label="Token 用量"
                value={formatTrajectoryTokens(record.totalTokens ?? 0)}
                sub="来自子执行记录"
              />
              <Metric label="总耗时" value={formatTrajectoryDuration(record.durationMs)} />
            </div>
            <div className="mt-3">
              <KV
                pairs={[
                  ['子 Agent', record.name ?? '—'],
                  [
                    '模型',
                    <span key="m" className="font-mono">
                      {record.model ?? '—'}
                    </span>,
                  ],
                  ['内部调用', `${record.children?.length ?? 0} 次工具`],
                ]}
              />
            </div>
            {(record.children?.length ?? 0) > 0 && (
              <div className="mt-3.5">
                <div className="mb-1 text-label text-foreground-faint">内部调用</div>
                <div className="grid gap-1.5">
                  {record.children?.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-xs text-foreground-body"
                    >
                      <span className="font-mono">{c.name}</span>
                      <span className="min-w-0 truncate text-foreground-faint">{c.target}</span>
                      <span className="ml-auto text-label tabular-nums text-foreground-faint">
                        {formatTrajectoryDuration(c.durationMs)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {record?.kind === 'subagent' && currentTab === '结果' && (
          <div className="whitespace-pre-wrap break-words text-foreground-body">
            {record.result}
          </div>
        )}

        {request && currentTab === '概览' && (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              <Metric label="模型" value={request.model} />
              <Metric label="尝试" value={request.attempt} />
              <Metric label="耗时" value={formatTrajectoryDuration(request.durationMs)} />
              <Metric
                label="状态"
                value={request.status === 'error' ? '失败' : '成功'}
                sub={request.status === 'error' ? request.error : undefined}
              />
            </div>
            {request.tokens && (
              <div className="mt-2.5 grid grid-cols-2 gap-2.5">
                <Metric label="输入 token" value={formatTrajectoryTokens(request.tokens.input)} />
                <Metric label="输出 token" value={formatTrajectoryTokens(request.tokens.output)} />
                <Metric label="缓存命中" value={formatTrajectoryTokens(request.tokens.cache)} />
              </div>
            )}
            <div className="mt-3">
              <KV pairs={[['所属轮次', turnLabel ?? '—']]} />
            </div>
          </>
        )}

        {compaction && currentTab === '概览' && (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              <Metric
                label="压缩前上下文"
                value={`${formatTrajectoryTokens(compaction.beforeTokens)} tok`}
              />
              <Metric
                label="压缩后上下文"
                value={`${formatTrajectoryTokens(compaction.afterTokens)} tok`}
              />
              <Metric
                label="释放"
                value={`${formatTrajectoryTokens(compaction.beforeTokens - compaction.afterTokens)} tok`}
                sub={`−${((1 - compaction.afterTokens / compaction.beforeTokens) * 100).toFixed(1)}%`}
              />
              <Metric label="压缩耗时" value={formatTrajectoryDuration(compaction.durationMs)} />
            </div>
            <div className="mt-3">
              <KV
                pairs={[
                  ['总结消息', `${compaction.messages} 条`],
                  ['压缩策略', compaction.strategy ?? '—'],
                  [
                    '发生时刻',
                    `${compaction.at} · 轮次 ${compaction.afterTurn} → ${compaction.afterTurn + 1} 之间`,
                  ],
                ]}
              />
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
