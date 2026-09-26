// INTENTIONAL-UNTESTED: pointer/DOM view without a unit harness (no DOM test dependency); the order
// logic lives in model.ts (mergeSubOrder/moveInList, unit-tested) and the view is exercised by the
// in-app selftest (side card click, Alt+Arrow reorder) and by a real-mouse Playwright run.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { SessionInfo } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { Badge, ColorMark, displayTitle, StatusDot } from '../components/SessionHeader'
import { slotRef } from '../layout-sync'
import { moveInList } from '../model'
import { useT } from '../i18n'
import { AgentPreview } from './AgentPreview'
import { LiveTile } from './LiveTile'

/** Below this many pixels of movement a press is a click (make big), above it a drag (re-sort). */
const DRAG_THRESHOLD = 6
const GAP = 8

type Props = {
  big: SessionInfo | null
  /** Every visible session in order; the big one stays in the list, highlighted as open. */
  others: SessionInfo[]
  onFocus: (id: string) => void
  onMinimize: (id: string) => void
  onRelease: (id: string) => void
  /** The side list in its new order. */
  onReorder: (ids: string[]) => void
}

type Drag = {
  id: string
  pointerId: number
  startY: number
  dy: number
  active: boolean
  /** Card centres and heights at drag start, in list order. */
  centers: number[]
  heights: number[]
  from: number
  target: number
}

export function FocusView({ big, others, onFocus, onMinimize, onRelease, onReorder }: Props) {
  const t = useT()
  const [drag, setDrag] = useState<Drag | null>(null)
  const items = useRef(new Map<string, HTMLLIElement>())
  const suppressClick = useRef(false)
  const ids = others.map((s) => s.id)

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return
    suppressClick.current = false // a drag released outside the card never produced its click
    const boxes = ids.map((x) => items.current.get(x)?.getBoundingClientRect())
    if (boxes.some((b) => !b)) return
    const from = ids.indexOf(id)
    setDrag({
      id,
      pointerId: e.pointerId,
      startY: e.clientY,
      dy: 0,
      active: false,
      centers: boxes.map((b) => b!.top + b!.height / 2),
      heights: boxes.map((b) => b!.height),
      from,
      target: from
    })
  }

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return
    const dy = e.clientY - drag.startY
    const active = drag.active || Math.abs(dy) > DRAG_THRESHOLD
    if (active && !drag.active) e.currentTarget.setPointerCapture(e.pointerId)
    const center = drag.centers[drag.from] + dy
    const target = drag.centers.filter((c, i) => i !== drag.from && c < center).length
    setDrag({ ...drag, dy, active, target })
  }

  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return
    if (drag.active) {
      suppressClick.current = true // the click that follows this release is not a "make big"
      if (drag.target !== drag.from) onReorder(moveInList(ids, drag.id, drag.target, true))
    }
    setDrag(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    const next = moveInList(ids, id, e.key === 'ArrowUp' ? -1 : 1)
    if (next !== ids) onReorder(next)
  }

  /** Visual offset while dragging: the dragged card follows the pointer, the others make room. */
  const offset = (index: number): number => {
    if (!drag?.active) return 0
    if (index === drag.from) return drag.dy
    const room = drag.heights[drag.from] + GAP
    if (drag.from < drag.target && index > drag.from && index <= drag.target) return -room
    if (drag.from > drag.target && index >= drag.target && index < drag.from) return room
    return 0
  }

  const listed = others.length > 1 // alone, the big one needs no list
  return (
    <div className={`focus-view${listed ? '' : ' is-single'}`}>
      <div className="focus-main">
        {big ? (
          <LiveTile session={big} onMinimize={() => onMinimize(big.id)} onRelease={() => onRelease(big.id)} />
        ) : (
          <p className="placeholder">{t.allDocked}</p>
        )}
      </div>
      {listed && (
        <aside className="focus-side" aria-label={t.moreTerminals} data-clip>
          <ul className={`side-list${drag?.active ? ' is-sorting' : ''}`}>
            {others.map((s, i) => {
              const open = s.id === big?.id
              return (
                <li
                  key={s.id}
                  ref={(el) => {
                    if (el) items.current.set(s.id, el)
                    else items.current.delete(s.id)
                  }}
                  className={drag?.active && drag.id === s.id ? 'is-dragging' : undefined}
                  style={{ transform: offset(i) ? `translateY(${offset(i)}px)` : undefined }}
                >
                  <button
                    type="button"
                    className={`side-card is-${s.activity}${s.badge ? ' has-badge' : ''}${open ? ' is-open' : ''}`}
                    data-id={s.id}
                    aria-current={open ? 'true' : undefined}
                    onPointerDown={(e) => onPointerDown(e, s.id)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={() => setDrag(null)}
                    onKeyDown={(e) => onKeyDown(e, s.id)}
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false
                        return
                      }
                      if (!open) onFocus(s.id)
                    }}
                    title={t.sideCardTitle}
                    aria-label={t.sideCard(displayTitle(s), s.badge)}
                  >
                    <span className="side-head">
                      <StatusDot session={s} />
                      <ColorMark session={s} />
                      <span className="side-title">{displayTitle(s)}</span>
                      {open && <span className="open-mark">{t.openNow}</span>}
                      <Badge session={s} />
                    </span>
                    {s.agent ? (
                      <AgentPreview id={s.id} />
                    ) : (
                      <span className="side-thumb" ref={slotRef(s.id, open ? 'mirror' : 'thumb')} />
                    )}
                  </button>
                  {s.agent?.role === 'plain' && !s.agent.exited && (
                    <button
                      type="button"
                      className="card-unlock"
                      aria-pressed={s.agent.unlocked}
                      aria-label={t.agentUnlockCard(displayTitle(s), s.agent.unlocked)}
                      title={s.agent.unlocked ? t.agentUnlocked : t.agentUnlock}
                      onClick={() => window.organizer.unlockAgent(s.id, !s.agent?.unlocked)}
                    >
                      <Icon name="agent" />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </aside>
      )}
    </div>
  )
}
