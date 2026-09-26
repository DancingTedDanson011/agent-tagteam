// Workspaces remember a view and an arrangement. Captured windows do not survive a restart, so a
// saved slot finds "its" session again by rule (process + title), else slots fill in order.
import { cleanTitle } from '../../shared/restore'
import type { SessionInfo, SlotLaunch, Workspace, WorkspaceSlot } from '../../shared/types'
import type { UiState } from './model'

export { cleanTitle }

function matches(slot: WorkspaceSlot, s: SessionInfo): boolean {
  if (slot.rule.processName.toLowerCase() !== s.processName.toLowerCase()) return false
  return slot.rule.titleIncludes === '' || cleanTitle(s.title).includes(slot.rule.titleIncludes)
}

/**
 * Session id -> slot index. The saved name first (it survives title changes), then the rule (unnamed
 * slots only), then remaining sessions fill free slots in order — except slots that can start their
 * own window again: an unrelated session there would stop the real one from coming back.
 */
export function assignSlots(ws: Workspace, sessions: SessionInfo[]): Map<string, number> {
  const result = new Map<string, number>()
  const used = new Set<number>()
  const take = (pick: (slot: WorkspaceSlot, s: SessionInfo) => boolean) =>
    ws.slots.forEach((slot, i) => {
      if (used.has(i)) return
      const hit = sessions.find((s) => !result.has(s.id) && pick(slot, s))
      if (hit) {
        result.set(hit.id, i)
        used.add(i)
      }
    })
  take((slot, s) => !!slot.label && slot.label === s.label && slot.rule.processName.toLowerCase() === s.processName.toLowerCase())
  // A named slot takes only its name: titles like "cmd.exe" repeat, and the wrong window would stop
  // the named one from coming back (measured in the selftest).
  take((slot, s) => !slot.label && matches(slot, s))
  for (const s of sessions) {
    if (result.has(s.id)) continue
    const free = ws.slots.findIndex((slot, i) => !used.has(i) && !slot.launch)
    if (free < 0) break
    result.set(s.id, free)
    used.add(free)
  }
  return result
}

/** Slots whose window is not open but can be started again. */
export function missingSlots(ws: Workspace, sessions: SessionInfo[]): number[] {
  const filled = new Set(assignSlots(ws, sessions).values())
  return ws.slots.flatMap((slot, i) => (slot.launch && !filled.has(i) ? [i] : []))
}

/** recipes: how each session comes back (from main; null = it cannot). */
export function workspaceFromState(st: UiState, name: string, id: string, recipes: Record<string, SlotLaunch | null> = {}, resume = false): Workspace {
  const slots: WorkspaceSlot[] = st.order.flatMap((sid) => {
    const s = st.sessions.find((x) => x.id === sid)
    if (!s) return []
    const slot: WorkspaceSlot = { rule: { processName: s.processName, titleIncludes: cleanTitle(s.title) } }
    if (st.free[sid]) slot.free = st.free[sid]
    if (s.label) slot.label = s.label
    if (s.color) slot.color = s.color
    const launch = recipes[sid]
    if (launch) slot.launch = launch
    return [slot]
  })
  return { id, name, view: st.view, slots, ...(resume ? { resume: true } : {}) }
}
