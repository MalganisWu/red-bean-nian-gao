'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '../lib/utils'
import {
  formatTrajectoryDuration,
  formatTrajectoryGap,
  trajectoryTimeToSeconds,
  type TrajectoryCompaction,
  type TrajectoryRecord,
  type TrajectoryTurn,
} from './trajectoryTypes'

/** 泳道键：用户 / 工具 / LLM 步骤 / 压缩。顺序即展示顺序。 */
type LaneKey = 'user' | 'tool' | 'call' | 'cmp'

/** 泳道定义；压缩道的段由 compaction 单独提供，不走 records。 */
const LANES: readonly { key: LaneKey; label: string; match: (r: TrajectoryRecord) => boolean }[] = [
  { key: 'user', label: '用户', match: (r) => r.kind === 'user' },
  { key: 'tool', label: '工具', match: (r) => r.kind === 'tool' || r.kind === 'subagent' },
  { key: 'call', label: 'LLM 调用', match: (r) => r.kind === 'call' },
  { key: 'cmp', label: '压缩', match: () => false },
]

/** 轨迹时间轴的 Props；`onSelect` 与 `onRangeFocus` 分别对应点选与拖选两种交互。 */
export interface TrajectoryTimelineProps {
  /** 轮次数据（时序排列）。 */
  turns: TrajectoryTurn[]
  /** 会话级压缩事件；没有则不渲染压缩道的内容。 */
  compaction?: TrajectoryCompaction | undefined
  /** 当前选中记录 id；选中段带品牌色描边。 */
  selectedId?: string | undefined
  /** 点击段/压缩标记时回调记录 id（压缩为 compaction.id）。 */
  onSelect?: ((id: string) => void) | undefined
  /**
   * 区域选择回调：拖选时间区间时回调区间内活动记录的 id 集合（供记录表聚焦/淡隐），
   * 清除选择（右键 / Esc / 清除按钮）时回调 null。
   */
  onRangeFocus?: ((idsInRange: ReadonlySet<string> | null) => void) | undefined
}

interface Positioned {
  id: string
  left: number
  width: number
}

/**
 * 计算全局位置表：时序模式下活动段宽度 ∝ 真实耗时、超过 2s 的空档折叠为 2.5s 等效窄缝；
 * 序列模式下全部记录等宽按序。四条泳道共享同一 x 轴，同一列 ≈ 同一时刻附近。
 * 请求子记录不占泳道，但继承所属步骤的位置（供区域选择的淡隐判断）。
 */
function usePositions(
  turns: TrajectoryTurn[],
  compaction: TrajectoryCompaction | undefined,
  mode: 'time' | 'seq'
): Map<string, Positioned> {
  return useMemo(() => {
    const items: { id: string; at: number; dur: number }[] = []
    for (const t of turns) {
      for (const r of t.records) {
        items.push({ id: r.id, at: trajectoryTimeToSeconds(r.at), dur: (r.durationMs ?? 0) / 1000 })
      }
    }
    if (compaction) {
      items.push({
        id: compaction.id,
        at: trajectoryTimeToSeconds(compaction.at),
        dur: compaction.durationMs / 1000,
      })
    }
    items.sort((a, b) => a.at - b.at)

    const pos = new Map<string, Positioned>()
    if (items.length === 0) return pos
    if (mode === 'seq') {
      const n = items.length
      items.forEach((it, i) => pos.set(it.id, { id: it.id, left: (i / n) * 100, width: 100 / n }))
    } else {
      const GAP_EQ = 2.5
      const THRESH = 2
      let x = 0
      let prevEnd = items[0]?.at ?? 0
      for (const it of items) {
        const g = it.at - prevEnd
        x += g > THRESH ? GAP_EQ : Math.max(g, 0)
        pos.set(it.id, { id: it.id, left: x, width: it.dur })
        x += it.dur
        prevEnd = Math.max(prevEnd, it.at + it.dur)
      }
      const total = x || 1
      for (const p of pos.values()) {
        p.left = (p.left / total) * 100
        p.width = Math.max((p.width / total) * 100, 0.9)
      }
    }
    /* 请求子记录继承所属步骤位置 */
    for (const t of turns) {
      for (const r of t.records) {
        const p = pos.get(r.id)
        if (!p) continue
        for (const q of r.attempts ?? []) pos.set(q.id, p)
      }
    }
    return pos
  }, [turns, compaction, mode])
}

function segClass(r: TrajectoryRecord): string {
  if (r.kind === 'user') return 'bg-brand-indicator'
  if (r.kind === 'call') return 'bg-foreground-faint'
  if (r.kind === 'subagent') return 'bg-cat-sub-soft border border-cat-sub-indicator'
  if (r.status === 'error') return 'bg-danger-indicator'
  return 'bg-cat-tool-indicator'
}

function segLabel(r: TrajectoryRecord): string {
  if (r.kind === 'user') return '用户'
  if (r.kind === 'call') return 'LLM 调用'
  if (r.kind === 'subagent') return '子 Agent'
  return r.status === 'error' ? '工具 · 失败' : '工具'
}

/**
 * 会话轨迹的顶部泳道时序概览：四条泳道（用户/工具/LLM 步骤/压缩），段位置与宽度
 * 按真实时刻与耗时投影，大空档折叠为窄缝；点击段回调选中，供与记录表联动。
 * 失败段就地红色显示在所属泳道；子 Agent 是工具泳道内的空心段。
 * 支持拖选时间区间聚焦（onRangeFocus 回调区间内记录集合）、Ctrl/⌘+滚轮缩放、
 * 右键/Esc/清除按钮复位。
 */
export function TrajectoryTimeline({
  turns,
  compaction,
  selectedId,
  onSelect,
  onRangeFocus,
}: TrajectoryTimelineProps) {
  const [mode, setMode] = useState<'time' | 'seq'>('time')
  const positions = usePositions(turns, compaction, mode)
  const [rangeSel, setRangeSel] = useState<{ l: number; r: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const lanesRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<number | null>(null)

  /* 区间变化时向消费方通告区间内记录集合 */
  useEffect(() => {
    if (!onRangeFocus) return
    if (!rangeSel) {
      onRangeFocus(null)
      return
    }
    const ids = new Set<string>()
    for (const p of positions.values()) {
      const l = p.left
      const r = p.left + p.width
      if (r >= rangeSel.l && l <= rangeSel.r) ids.add(p.id)
    }
    onRangeFocus(ids)
  }, [rangeSel, positions, onRangeFocus])

  /* Esc 复位选区 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRangeSel(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* Ctrl/⌘+滚轮缩放需要 non-passive 监听才能 preventDefault */
  useEffect(() => {
    const host = lanesRef.current
    if (!host) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const track = host.querySelector('.trajectory-lane-track')
      const rect = track?.getBoundingClientRect()
      const originPct = rect ? ((e.clientX - rect.left) / rect.width) * 100 : 50
      setZoom((z) => Math.min(8, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 0.87))))
      host.querySelectorAll('.trajectory-lane-track').forEach((t) => {
        if (!(t instanceof HTMLElement)) return
        t.style.transformOrigin = `${originPct}% center`
      })
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [])

  const pctOfClientX = (clientX: number): number => {
    const track = lanesRef.current?.querySelector('.trajectory-lane-track')
    const rect = track?.getBoundingClientRect()
    if (!rect) return 0
    return Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100))
  }

  const first = turns[0]
  const last = turns[turns.length - 1]
  const rangeLabel =
    first && last
      ? `${first.startedAt} — ${last.startedAt} · 跨度 ${formatTrajectoryGap(
          trajectoryTimeToSeconds(last.startedAt) +
            last.durationMs / 1000 -
            trajectoryTimeToSeconds(first.startedAt)
        )}`
      : ''

  return (
    <section aria-label="会话时序概览" className="border-b border-border px-6 pb-2.5 pt-3">
      <div className="mb-2.5 flex items-center gap-3">
        <span className="text-label text-foreground-faint">概览</span>
        <div
          className="flex overflow-hidden rounded-md border border-border"
          role="group"
          aria-label="概览模式"
        >
          {(['time', 'seq'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'px-2.5 py-[3px] text-label transition-colors',
                mode === m
                  ? 'bg-muted text-foreground'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              {m === 'time' ? '时序' : '序列'}
            </button>
          ))}
        </div>
        <span className="text-label text-foreground-faint">
          {mode === 'time'
            ? '时序模式：宽度 ∝ 真实耗时，大空档折叠为窄缝'
            : '序列模式：全局序号对齐，等宽按序'}
        </span>
        {rangeSel && (
          <button
            type="button"
            onClick={() => setRangeSel(null)}
            className="rounded-md border border-border bg-background px-2 py-0.5 text-label text-brand-text"
          >
            清除选择 ×
          </button>
        )}
        <span className="ml-auto text-label tabular-nums text-foreground-faint">{rangeLabel}</span>
      </div>

      <div
        ref={lanesRef}
        className="relative grid select-none gap-y-1.5"
        onMouseDown={(e) => {
          if (e.button !== 0) return
          if (!(e.target instanceof HTMLElement)) return
          if (e.target.closest('button')) return
          const x = pctOfClientX(e.clientX)
          dragRef.current = x
          setRangeSel({ l: x, r: x })
          e.preventDefault()
        }}
        onMouseMove={(e) => {
          if (dragRef.current === null) return
          const x = pctOfClientX(e.clientX)
          setRangeSel({ l: Math.min(dragRef.current, x), r: Math.max(dragRef.current, x) })
        }}
        onMouseUp={() => {
          /* 宽度不足 0.5% 视为单击，不成选区 */
          setRangeSel((cur) => (cur && cur.r - cur.l < 0.5 ? null : cur))
          dragRef.current = null
        }}
        onContextMenu={(e) => {
          if (rangeSel) {
            e.preventDefault()
            setRangeSel(null)
          }
        }}
      >
        {rangeSel && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-[-3px] z-[5] border-x border-brand-indicator bg-brand-indicator/10"
            style={{ left: `${rangeSel.l}%`, width: `${rangeSel.r - rangeSel.l}%` }}
          />
        )}
        {LANES.map((lane) => (
          <div key={lane.key} className="grid grid-cols-[52px_1fr] items-center gap-3">
            <span className="whitespace-nowrap text-right text-label text-foreground-faint">
              {lane.label}
            </span>
            <div
              className="trajectory-lane-track relative h-2"
              style={zoom !== 1 ? { transform: `scaleX(${zoom})` } : undefined}
            >
              <span
                aria-hidden="true"
                className="absolute inset-x-0 top-1/2 h-px bg-border opacity-50"
              />
              {lane.key === 'cmp' && compaction
                ? (() => {
                    const p = positions.get(compaction.id)
                    if (!p) return null
                    return (
                      <button
                        type="button"
                        aria-label="上下文压缩"
                        onClick={() => onSelect?.(compaction.id)}
                        style={{
                          left: `${Math.min(p.left, 100 - p.width)}%`,
                          width: `${p.width}%`,
                        }}
                        className={cn(
                          'absolute top-1/2 h-2 min-w-1 -translate-y-1/2 rounded-full border border-dashed border-cat-cmp-indicator bg-cat-cmp-soft transition-transform hover:scale-y-150',
                          selectedId === compaction.id &&
                            'outline outline-2 outline-offset-1 outline-brand-indicator',
                          rangeSel &&
                            !isInRange(positions.get(compaction.id), rangeSel) &&
                            'opacity-25'
                        )}
                        title={`上下文压缩 · ${compaction.at}\n${compaction.beforeTokens.toLocaleString('en-US')} → ${compaction.afterTokens.toLocaleString('en-US')} tok · ${formatTrajectoryDuration(compaction.durationMs)}`}
                      />
                    )
                  })()
                : null}
              {lane.key !== 'cmp'
                ? turns
                    .flatMap((t) => t.records)
                    .filter(lane.match)
                    .map((r) => {
                      const p = positions.get(r.id)
                      if (!p) return null
                      const isUser = r.kind === 'user'
                      return (
                        <button
                          key={r.id}
                          type="button"
                          aria-label={`${segLabel(r)} ${r.summary}`}
                          onClick={() => onSelect?.(r.id)}
                          style={
                            isUser
                              ? { left: `${Math.min(p.left, 99)}%`, width: 3 }
                              : {
                                  left: `calc(${Math.min(p.left, 100 - p.width)}% + 1px)`,
                                  width: `calc(${p.width}% - 2px)`,
                                }
                          }
                          className={cn(
                            'absolute top-1/2 h-2 min-w-1 -translate-y-1/2 rounded-full transition-transform hover:scale-y-150',
                            isUser && 'h-2.5',
                            segClass(r),
                            selectedId === r.id &&
                              'outline outline-2 outline-offset-1 outline-brand-indicator',
                            rangeSel && !isInRange(p, rangeSel) && 'opacity-25'
                          )}
                          title={`${segLabel(r)} · ${r.name ?? r.summary}\n${r.at} · ${formatTrajectoryDuration(r.durationMs)}`}
                        />
                      )
                    })
                : null}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 flex gap-3.5 text-label text-foreground-muted">
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-[3px] bg-brand-indicator" />
          用户
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-[3px] bg-cat-tool-indicator" />
          工具
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-[3px] bg-foreground-faint" />
          LLM 步骤
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-[3px] bg-danger-indicator" />
          失败
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-[3px] border border-cat-sub-indicator bg-cat-sub-soft" />
          子 Agent
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-1.5 w-3.5 rounded-full border border-dashed border-cat-cmp-indicator bg-cat-cmp-soft" />
          压缩
        </span>
      </div>
    </section>
  )
}

/** 区间相交判断（位置表百分比域）。 */
function isInRange(p: Positioned | undefined, sel: { l: number; r: number }): boolean {
  if (!p) return false
  return p.left + p.width >= sel.l && p.left <= sel.r
}
