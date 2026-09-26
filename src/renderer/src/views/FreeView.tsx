import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { FreeRect, SessionInfo } from '../../../shared/types'
import { useT } from '../i18n'
import { LiveTile } from './LiveTile'

const MIN_W = 320
const MIN_H = 200

type Props = {
  sessions: SessionInfo[]
  free: Record<string, FreeRect>
  onMove: (id: string, rect: FreeRect) => void
  onRaise: (id: string) => void
  /** Brings a tile to the front without moving keyboard focus into its terminal. */
  onBringToFront: (id: string) => void
  onMinimize: (id: string) => void
  onRelease: (id: string) => void
}

function defaultRect(index: number, area: { width: number; height: number }): FreeRect {
  const width = Math.max(MIN_W, Math.round(area.width * 0.55))
  const height = Math.max(MIN_H, Math.round(area.height * 0.6))
  const step = 36
  return {
    x: Math.min(24 + index * step, Math.max(0, area.width - width)),
    y: Math.min(24 + index * step, Math.max(0, area.height - height)),
    width,
    height
  }
}

function clamp(r: FreeRect, area: { width: number; height: number }): FreeRect {
  const width = Math.min(Math.max(r.width, MIN_W), area.width)
  const height = Math.min(Math.max(r.height, MIN_H), area.height)
  return {
    x: Math.min(Math.max(r.x, 0), area.width - width),
    y: Math.min(Math.max(r.y, 0), area.height - height),
    width,
    height
  }
}

export function FreeView({ sessions, free, onMove, onRaise, onBringToFront, onMinimize, onRelease }: Props) {
  const t = useT()
  const areaRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1200, height: 800 })
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const area = () => size

  /** Pointer drag for moving (header) or resizing (corner grip). */
  const track = (id: string, start: FreeRect, mode: 'move' | 'resize') => (e: ReactPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.session-actions')) return
    e.preventDefault()
    onRaise(id)
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const ox = e.clientX
    const oy = e.clientY
    const onMovePointer = (ev: PointerEvent) => {
      const dx = ev.clientX - ox
      const dy = ev.clientY - oy
      const next =
        mode === 'move'
          ? { ...start, x: start.x + dx, y: start.y + dy }
          : { ...start, width: start.width + dx, height: start.height + dy }
      onMove(id, clamp(next, area()))
    }
    const end = () => {
      el.removeEventListener('pointermove', onMovePointer)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
    }
    el.addEventListener('pointermove', onMovePointer)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
  }

  const nudge = (id: string, rect: FreeRect) => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 12
    const moves: Record<string, Partial<FreeRect>> = {
      ArrowLeft: { x: rect.x - step },
      ArrowRight: { x: rect.x + step },
      ArrowUp: { y: rect.y - step },
      ArrowDown: { y: rect.y + step }
    }
    const m = moves[e.key]
    if (!m) return
    e.preventDefault()
    onMove(id, clamp({ ...rect, ...m }, area()))
  }

  return (
    <div ref={areaRef} className="free-view">
      {sessions.map((s, i) => {
        // Clamped on every render: a narrower window must never push tiles out of view.
        const rect = clamp(free[s.id] ?? defaultRect(i, size), size)
        return (
          <LiveTile
            key={s.id}
            session={s}
            className="is-floating"
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
            onMinimize={() => onMinimize(s.id)}
            onRelease={() => onRelease(s.id)}
            onHeaderPointerDown={track(s.id, rect, 'move')}
            onFocusWithin={() => onBringToFront(s.id)}
          >
            <button
              type="button"
              className="resize-grip"
              onPointerDown={track(s.id, rect, 'resize')}
              onKeyDown={nudge(s.id, rect)}
              title={t.resizeTitle}
            >
              <span className="sr-only">{t.resize(s.title)}</span>
            </button>
          </LiveTile>
        )
      })}
    </div>
  )
}
