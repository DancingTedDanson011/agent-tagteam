// UI state of the organizer and which role each session plays in the current view.
import type { DragState, FreeRect, RefusalReason, SessionInfo, ViewMode, Workspace } from '../../shared/types'
import { assignSlots } from './workspaces'

export type Modal = 'picker' | 'workspaces' | 'agent' | 'style' | 'voice'

export type UiState = {
  view: ViewMode
  sessions: SessionInfo[]
  order: string[]
  minimized: string[]
  /** The big session in focus view and the active tab in tabs view. */
  focusId: string | null
  /** A capture that has not shown up in the session list yet; it becomes the focus when it does. */
  pendingFocus: string | null
  free: Record<string, FreeRect>
  modal: Modal | null
  drag: DragState
  workspaces: Workspace[]
  workspaceId: string | null
  /** Sessions a workspace restore started: their slot, so they land there once they are listed. */
  restoredSlots: Record<string, number>
  /** A refused drag-in capture, worded by the page in its language. */
  notice: RefusalReason | null
}

export type Action =
  | { type: 'sessions'; list: SessionInfo[] }
  | { type: 'reorder'; order: string[] }
  | { type: 'view'; view: ViewMode }
  | { type: 'minimize'; id: string }
  | { type: 'restore'; id: string }
  | { type: 'focus'; id: string }
  | { type: 'captured'; id: string }
  | { type: 'moveFree'; id: string; rect: FreeRect }
  | { type: 'modal'; modal: Modal | null }
  | { type: 'drag'; state: DragState }
  | { type: 'workspaces'; list: Workspace[] }
  | { type: 'applyWorkspace'; workspace: Workspace }
  | { type: 'slotCaptured'; id: string; slot: number; workspaceId: string }
  | { type: 'notice'; reason: RefusalReason | null }

export function initialState(): UiState {
  return {
    view: 'focus',
    sessions: [],
    order: [],
    minimized: [],
    focusId: null,
    pendingFocus: null,
    free: {},
    modal: null,
    drag: { active: false, over: false },
    workspaces: [],
    workspaceId: null,
    restoredSlots: {},
    notice: null
  }
}

const visibleIds = (st: Pick<UiState, 'order' | 'minimized'>) => st.order.filter((id) => !st.minimized.includes(id))

/** Keeps focusId pointing at a visible session (or null when none is visible). */
function fixFocus(st: UiState): UiState {
  const visible = visibleIds(st)
  if (st.focusId && visible.includes(st.focusId)) return st
  return { ...st, focusId: visible[0] ?? null }
}

function pick<T>(record: Record<string, T>, keep: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => keep.has(k)))
}

/**
 * Moves a session a workspace restore started to its slot: before the first session of a later slot,
 * and gives it the slot's free rect.
 */
function placeRestored(st: UiState, id: string): UiState {
  const ws = st.workspaces.find((w) => w.id === st.workspaceId)
  const slot = st.restoredSlots[id]
  if (!ws || slot === undefined) return st
  const slotOf = new Map(assignSlots(ws, st.order.map((x) => st.sessions.find((y) => y.id === x)!).filter(Boolean)))
  for (const [rid, rslot] of Object.entries(st.restoredSlots)) slotOf.set(rid, rslot)
  const rest = st.order.filter((x) => x !== id)
  const at = rest.findIndex((x) => (slotOf.get(x) ?? Infinity) > slot)
  const order = at < 0 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)]
  const rect = ws.slots[slot]?.free
  return { ...st, order, free: rect ? { ...st.free, [id]: rect } : st.free }
}

export function reduce(st: UiState, a: Action): UiState {
  switch (a.type) {
    case 'sessions': {
      const ids = new Set(a.list.map((x) => x.id))
      const order = [...st.order.filter((id) => ids.has(id)), ...a.list.map((x) => x.id).filter((id) => !st.order.includes(id))]
      let next: UiState = {
        ...st,
        sessions: a.list,
        order,
        minimized: st.minimized.filter((id) => ids.has(id)),
        free: pick(st.free, ids),
        // a restored session that was listed and is gone is forgotten (its id can come back for another window)
        restoredSlots: Object.fromEntries(Object.entries(st.restoredSlots).filter(([id]) => ids.has(id) || !st.order.includes(id)))
      }
      for (const id of order) if (!st.order.includes(id) && id in st.restoredSlots) next = placeRestored(next, id)
      if (next.pendingFocus && ids.has(next.pendingFocus)) {
        next = { ...next, focusId: next.pendingFocus, pendingFocus: null }
      }
      return fixFocus(next)
    }
    case 'reorder': {
      const known = a.order.filter((id) => st.order.includes(id))
      return { ...st, order: [...known, ...st.order.filter((id) => !known.includes(id))] }
    }
    case 'view':
      return fixFocus({ ...st, view: a.view })
    case 'minimize':
      return fixFocus({ ...st, minimized: st.minimized.includes(a.id) ? st.minimized : [...st.minimized, a.id] })
    case 'restore':
      return fixFocus({ ...st, minimized: st.minimized.filter((id) => id !== a.id) })
    case 'focus':
      if (!st.order.includes(a.id)) return st
      return { ...st, minimized: st.minimized.filter((id) => id !== a.id), focusId: a.id }
    case 'captured':
      return st.order.includes(a.id)
        ? { ...st, focusId: a.id, minimized: st.minimized.filter((id) => id !== a.id) }
        : { ...st, pendingFocus: a.id }
    case 'moveFree':
      return { ...st, free: { ...st.free, [a.id]: a.rect } }
    case 'modal':
      return { ...st, modal: a.modal }
    case 'drag':
      return { ...st, drag: a.state }
    case 'workspaces':
      return { ...st, workspaces: a.list, workspaceId: a.list.some((w) => w.id === st.workspaceId) ? st.workspaceId : null }
    case 'applyWorkspace': {
      const slotOf = assignSlots(a.workspace, st.order.map((id) => st.sessions.find((x) => x.id === id)!).filter(Boolean))
      const assigned = [...slotOf.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id)
      const rest = st.order.filter((id) => !slotOf.has(id))
      const free = { ...st.free }
      for (const [id, slot] of slotOf) {
        const rect = a.workspace.slots[slot].free
        if (rect) free[id] = rect
      }
      return fixFocus({ ...st, view: a.workspace.view, order: [...assigned, ...rest], free, minimized: [], workspaceId: a.workspace.id, restoredSlots: {} })
    }
    case 'slotCaptured': {
      if (a.workspaceId !== st.workspaceId) return st // started for a workspace applied before the current one
      const next = { ...st, restoredSlots: { ...st.restoredSlots, [a.id]: a.slot } }
      return st.order.includes(a.id) ? placeRestored(next, a.id) : next
    }
    case 'notice':
      return { ...st, notice: a.reason }
  }
}

/**
 * Puts the members of `subset` into the given order while every other id keeps its position
 * (the big session and docked sessions stay where they are when the side list is re-sorted).
 */
export function mergeSubOrder(order: string[], subset: string[]): string[] {
  const inOrder = subset.filter((id) => order.includes(id))
  const members = new Set(inOrder)
  let next = 0
  return order.map((id) => (members.has(id) ? inOrder[next++] : id))
}

/** Moves `id` by `delta` places (or to index `delta` when `absolute`), clamped to the list. */
export function moveInList(list: string[], id: string, delta: number, absolute = false): string[] {
  const from = list.indexOf(id)
  if (from < 0) return list
  const to = Math.min(Math.max(absolute ? delta : from + delta, 0), list.length - 1)
  if (to === from) return list
  const rest = list.filter((x) => x !== id)
  return [...rest.slice(0, to), id, ...rest.slice(to)]
}

export type Roles ={ live: string[]; thumb: string[]; parked: string[]; attended: string[] }

export function roles(st: UiState): Roles {
  const visible = visibleIds(st)
  const docked = st.order.filter((id) => st.minimized.includes(id))
  if (st.modal) return { live: [], thumb: [], parked: [...st.order], attended: [] }
  switch (st.view) {
    case 'cockpit':
      return { live: [], thumb: [], parked: [...st.order], attended: [] }
    case 'free':
    case 'grid':
      return { live: visible, thumb: [], parked: docked, attended: [] }
    case 'focus': {
      const big = st.focusId && visible.includes(st.focusId) ? st.focusId : null
      return {
        live: big ? [big] : [],
        thumb: visible.filter((id) => id !== big),
        parked: docked,
        attended: big ? [big] : []
      }
    }
    case 'tabs': {
      const active = st.focusId && visible.includes(st.focusId) ? st.focusId : null
      return {
        live: active ? [active] : [],
        thumb: [],
        parked: st.order.filter((id) => id !== active),
        attended: active ? [active] : []
      }
    }
  }
}
