/*
 * 复合件 · RoundNav（轮次导航边沟）。
 * 对话页的轮次索引：每轮一根横杠，悬停出摘要卡、点击回调跳转。
 * 纯展示组件——轮次数据派生与滚动定位都在调用方。
 */
'use client'

import { useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { cn } from '../lib/utils'

/** 一个轮次对应的一根横杠。 */
export interface RoundNavEntry {
  id: string
  /** 悬停摘要卡内容（调用方渲染，如 Q+A+meta）；无则悬停不出卡 */
  preview?: ReactNode
}

/** 轮次导航的 Props。 */
export interface RoundNavProps {
  /** 按轮次顺序排列的条目；数组顺序即横杠的视觉顺序。 */
  entries: RoundNavEntry[]
  /** 当前轮 id（豆沙红伸长态） */
  currentId?: string | undefined
  /** 选中某一轮的回调；滚动定位由调用方实现，本组件不碰滚动容器。 */
  onSelect?: ((id: string) => void) | undefined
}

interface HoverState {
  entry: RoundNavEntry
  x: number
  y: number
}

const DEFAULT_WIDTH = 10
const CURRENT_WIDTH = 21
const PEAK_WIDTH = 42
const WAVE_RADIUS = 3

function waveWidth(distance: number): number {
  const influence = Math.max(0, 1 - distance / WAVE_RADIUS)
  return DEFAULT_WIDTH + (PEAK_WIDTH - DEFAULT_WIDTH) * Math.pow(influence, 1.32)
}

/**
 * 轮次导航边沟：每一轮用户消息一根小横杠，垂直居中于轨道。
 * 悬停或键盘聚焦出摘要卡（fixed，不抢交互），点击回调 onSelect（滚动定位由调用方做）。
 * 纯展示组件：数据派生与锚点跳转都在调用方。
 *
 * @param props - 组件属性；字段语义见 `RoundNavProps`。
 */
export function RoundNav(props: RoundNavProps) {
  const { entries, currentId, onSelect } = props
  const [hover, setHover] = useState<HoverState | null>(null)
  const [wavePosition, setWavePosition] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])

  // 摘要默认向轨道左侧展开；空间不足时回退到右侧。
  function showPreview(entry: RoundNavEntry, el: HTMLButtonElement, clientY?: number): void {
    if (!entry.preview) {
      setHover(null)
      return
    }
    const rect = el.getBoundingClientRect()
    const preferredLeft = rect.left - 310
    setHover({
      entry,
      x: preferredLeft >= 12 ? preferredLeft : rect.right + 10,
      y: Math.max(
        12,
        Math.min((clientY ?? rect.top + rect.height / 2) - 80, window.innerHeight - 200)
      ),
    })
  }

  /** 把位置吸附到最近的横杠：更新波纹宽度并展示该轮摘要。 */
  function activateAt(position: number, clientY?: number): void {
    if (entries.length === 0) return
    const clamped = Math.max(0, Math.min(entries.length - 1, position))
    const nearestIndex = Math.round(clamped)
    const button = buttonRefs.current[nearestIndex]
    const entry = entries[nearestIndex]
    setWavePosition(clamped)
    if (button && entry) showPreview(entry, button, clientY)
  }

  /** 清空波纹与悬停摘要，回到静止态。 */
  function resetWave(): void {
    setWavePosition(null)
    setHover(null)
  }

  const remainsInRail = (target: EventTarget | null): boolean =>
    target instanceof Node && Boolean(listRef.current?.contains(target))

  /** 键盘聚焦某根横杠时，用它的中心高度激活波纹与摘要。 */
  function handleMarkerFocus(index: number, event: FocusEvent<HTMLButtonElement>): void {
    const rect = event.currentTarget.getBoundingClientRect()
    activateAt(index, rect.top + rect.height / 2)
  }

  /** 把指针的纵向位置换算成横杠序号（首杠中心为原点，杠距为步长）。 */
  function handlePointerMove(clientY: number): void {
    const first = buttonRefs.current[0]
    const second = buttonRefs.current[1]
    if (!first) return
    const firstRect = first.getBoundingClientRect()
    const firstCenter = firstRect.top + firstRect.height / 2
    const secondRect = second?.getBoundingClientRect()
    const step = secondRect
      ? secondRect.top + secondRect.height / 2 - firstCenter
      : firstRect.height
    activateAt(step > 0 ? (clientY - firstCenter) / step : 0, clientY)
  }

  return (
    <>
      <div
        ref={listRef}
        className="flex h-full flex-col items-end justify-center overflow-y-auto py-4"
        onPointerMove={(event) => handlePointerMove(event.clientY)}
        onPointerLeave={resetWave}
      >
        {entries.map((entry, i) => (
          <button
            key={entry.id}
            ref={(node) => {
              buttonRefs.current[i] = node
            }}
            type="button"
            aria-label={`跳转到第 ${i + 1} 轮`}
            aria-current={currentId === entry.id ? 'step' : undefined}
            onClick={() => onSelect?.(entry.id)}
            onMouseEnter={(event) => {
              activateAt(i, event.clientY || undefined)
            }}
            onMouseLeave={(event) => {
              if (!remainsInRail(event.relatedTarget)) resetWave()
            }}
            onFocus={(event) => handleMarkerFocus(i, event)}
            onBlur={(event) => {
              if (!remainsInRail(event.relatedTarget)) resetWave()
            }}
            className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-end rounded-md pr-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <span
              aria-hidden="true"
              className={cn(
                'h-0.5 rounded-sm motion-safe:transition-[width,background-color,opacity] motion-safe:duration-[115ms]',
                wavePosition !== null
                  ? Math.abs(i - wavePosition) < 0.55
                    ? 'bg-foreground'
                    : 'bg-round-nav-marker'
                  : currentId === entry.id
                    ? 'bg-brand-indicator'
                    : 'bg-round-nav-marker'
              )}
              style={{
                width: `${
                  wavePosition === null
                    ? currentId === entry.id
                      ? CURRENT_WIDTH
                      : DEFAULT_WIDTH
                    : Number(waveWidth(Math.abs(i - wavePosition)).toFixed(2))
                }px`,
                opacity:
                  wavePosition === null
                    ? 1
                    : Number(
                        (
                          0.72 +
                          Math.max(0, 1 - Math.abs(i - wavePosition) / WAVE_RADIUS) * 0.28
                        ).toFixed(2)
                      ),
              }}
            />
          </button>
        ))}
      </div>

      {hover && (
        <div
          data-testid="round-nav-preview"
          className="pointer-events-none fixed z-50 w-[300px] rounded-xl border border-border-strong bg-popover px-3.5 py-3 shadow-lg"
          style={{ left: hover.x, top: hover.y }}
        >
          {hover.entry.preview}
        </div>
      )}
    </>
  )
}
