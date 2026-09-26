// Slots are the empty areas where a real window (live) or a DWM thumbnail (thumb) appears.
// Components register their slot elements; one animation-frame loop measures them and tells main.
// INTENTIONAL-UNTESTED: DOM measurement loop without a unit harness (no DOM test dependency); its
// behaviour is pinned end-to-end by the in-app selftest, which checks every window sits on its slot.
import { useEffect, useRef } from 'react'
import type { Layout, SlotPlacement, SlotRect } from '../../shared/types'

type SlotMode = 'live' | 'thumb' | 'mirror'
const slots = new Map<string, { el: HTMLElement; mode: SlotMode }>()
/** Where the big (live) window also shows as a preview of itself: the focus view's side list. */
const mirrors = new Map<string, HTMLElement>()

export function slotRef(id: string, mode: SlotMode) {
  if (mode === 'mirror') {
    return (el: HTMLElement | null) => {
      if (el) mirrors.set(id, el)
      else mirrors.delete(id)
    }
  }
  return (el: HTMLElement | null) => {
    if (el) slots.set(id, { el, mode })
    else if (slots.get(id)?.mode === mode) slots.delete(id)
  }
}

const toRect = (r: DOMRect): SlotRect => ({
  x: Math.round(r.left),
  y: Math.round(r.top),
  width: Math.round(r.width),
  height: Math.round(r.height)
})

/**
 * Measures all registered slots each frame and sends the layout when it changed.
 * A thumbnail inside a scroll list (an ancestor marked `data-clip`) carries that list's visible
 * area, because DWM would otherwise paint it outside the list, over the title bar.
 */
export function useLayoutSync(sessionIds: string[], attended: string[], modal: boolean): void {
  const ids = useRef(sessionIds)
  const att = useRef(attended)
  const dialog = useRef(modal)
  ids.current = sessionIds
  att.current = attended
  dialog.current = modal

  useEffect(() => {
    let last = ''
    let frame = 0
    const loop = () => {
      const placements: SlotPlacement[] = ids.current.map((id) => {
        const slot = slots.get(id)
        if (!slot || !slot.el.isConnected) return { id, mode: 'parked' }
        const r = slot.el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return { id, mode: 'parked' }
        if (slot.mode === 'live') {
          const m = mirrors.get(id)
          const mr = m?.isConnected ? m.getBoundingClientRect() : null
          if (!m || !mr || mr.width < 1 || mr.height < 1) return { id, mode: 'live', rect: toRect(r) }
          const clipEl = m.closest<HTMLElement>('[data-clip]')
          return clipEl
            ? { id, mode: 'live', rect: toRect(r), mirror: toRect(mr), clip: toRect(clipEl.getBoundingClientRect()) }
            : { id, mode: 'live', rect: toRect(r), mirror: toRect(mr) }
        }
        const clipEl = slot.el.closest<HTMLElement>('[data-clip]')
        return clipEl
          ? { id, mode: 'thumb', rect: toRect(r), clip: toRect(clipEl.getBoundingClientRect()) }
          : { id, mode: 'thumb', rect: toRect(r) }
      })
      const layout: Layout = { placements, attended: att.current, modal: dialog.current }
      const json = JSON.stringify(layout)
      if (json !== last) {
        last = json
        window.organizer.setLayout(layout)
      }
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [])
}
