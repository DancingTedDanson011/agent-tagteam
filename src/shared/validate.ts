// Validation of everything that crosses the renderer -> main boundary or comes from disk.
// Returns a clean copy (unknown fields dropped) or null.
import { parseColorId, parseLabel, parseSlotLaunch } from './restore'
import type { AgentProvider, AgentStart, FreeRect, Lang, Layout, SlotPlacement, SlotRect, ViewMode, Workspace, WorkspaceSlot } from './types'

const MAX_PLACEMENTS = 1000
const MAX_TEXT = 200
const VIEWS: readonly ViewMode[] = ['free', 'grid', 'focus', 'tabs']

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isText = (v: unknown, allowEmpty: boolean): v is string =>
  typeof v === 'string' && v.length <= MAX_TEXT && (allowEmpty || v.length > 0)

export function parseLang(v: unknown): Lang | null {
  return v === 'de' || v === 'en' ? v : null
}

/** A captured window's handle. Everything that touches a window takes only this. */
export function parseId(v: unknown): string | null {
  return typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v) ? v : null
}

/** An agent tile (a terminal this app runs itself). */
export function parseAgentId(v: unknown): string | null {
  return typeof v === 'string' && /^a[1-9][0-9]{0,8}$/.test(v) ? v : null
}

/** Any tile: a captured window or an agent. */
export function parseSessionId(v: unknown): string | null {
  return parseId(v) ?? parseAgentId(v)
}

export function parseIdList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_PLACEMENTS) return null
  const ids = v.map(parseSessionId)
  return ids.some((id) => id === null) ? null : (ids as string[])
}

function parseRect(v: unknown): SlotRect | null {
  if (!isObj(v) || !isNum(v.x) || !isNum(v.y) || !isNum(v.width) || !isNum(v.height)) return null
  if (v.width < 0 || v.height < 0) return null
  return { x: v.x, y: v.y, width: v.width, height: v.height }
}

function parsePlacement(v: unknown): SlotPlacement | null {
  if (!isObj(v)) return null
  const id = parseSessionId(v.id)
  if (!id) return null
  if (v.mode === 'parked') return { id, mode: 'parked' }
  if (v.mode !== 'live' && v.mode !== 'thumb') return null
  const rect = parseRect(v.rect)
  if (!rect) return null
  if (v.mode === 'live') {
    if (v.mirror === undefined) return { id, mode: 'live', rect }
    const mirror = parseRect(v.mirror)
    const clip = v.clip === undefined ? undefined : parseRect(v.clip)
    if (!mirror || clip === null) return null
    return clip ? { id, mode: 'live', rect, mirror, clip } : { id, mode: 'live', rect, mirror }
  }
  if (v.clip === undefined) return { id, mode: 'thumb', rect }
  const clip = parseRect(v.clip)
  return clip ? { id, mode: 'thumb', rect, clip } : null
}

export function parseLayout(v: unknown): Layout | null {
  if (!isObj(v) || !Array.isArray(v.placements) || !Array.isArray(v.attended)) return null
  if (v.placements.length > MAX_PLACEMENTS || v.attended.length > MAX_PLACEMENTS) return null
  if (v.modal !== undefined && typeof v.modal !== 'boolean') return null
  const placements = v.placements.map(parsePlacement)
  const attended = v.attended.map(parseSessionId)
  if (placements.some((p) => p === null) || attended.some((a) => a === null)) return null
  const layout: Layout = { placements: placements as SlotPlacement[], attended: attended as string[] }
  if (v.modal !== undefined) layout.modal = v.modal
  return layout
}

function parseSlot(v: unknown): WorkspaceSlot | null {
  if (!isObj(v) || !isObj(v.rule)) return null
  const { processName, titleIncludes } = v.rule
  if (!isText(processName, false) || !isText(titleIncludes, true)) return null
  const slot: WorkspaceSlot = { rule: { processName, titleIncludes } }
  if (v.free !== undefined) {
    const free = parseRect(v.free)
    if (!free) return null
    slot.free = free as FreeRect
  }
  // Name, colour and restore recipe are extras: a bad one is dropped, the slot and the list stay.
  const label = parseLabel(v.label)
  if (label) slot.label = label
  const color = parseColorId(v.color)
  if (color) slot.color = color
  const launch = parseSlotLaunch(v.launch)
  if (launch) slot.launch = launch
  return slot
}

export function parseWorkspaces(v: unknown): Workspace[] | null {
  if (!Array.isArray(v) || v.length > MAX_PLACEMENTS) return null
  const out: Workspace[] = []
  for (const w of v) {
    if (!isObj(w) || !isText(w.id, false) || !isText(w.name, false)) return null
    if (!VIEWS.includes(w.view as ViewMode) || !Array.isArray(w.slots) || w.slots.length > MAX_PLACEMENTS) return null
    const slots = w.slots.map(parseSlot)
    if (slots.some((s) => s === null)) return null
    const ws: Workspace = { id: w.id, name: w.name, view: w.view as ViewMode, slots: slots as WorkspaceSlot[] }
    if (w.resume === true) ws.resume = true
    out.push(ws)
  }
  return out
}

/** A restore-journal entry as the app or the watchdog wrote it; anything else is dropped. */
export type JournalEntryShape = {
  hwnd: string
  pid: number
  startTime: string | null
  className: string
  style: number
  exStyle: number
  placement: {
    length: number
    flags: number
    showCmd: number
    ptMinPosition: { x: number; y: number }
    ptMaxPosition: { x: number; y: number }
    rcNormalPosition: { left: number; top: number; right: number; bottom: number }
  }
}

const isPoint = (v: unknown): v is { x: number; y: number } => isObj(v) && isNum(v.x) && isNum(v.y)
const isWinRect = (v: unknown): v is JournalEntryShape['placement']['rcNormalPosition'] =>
  isObj(v) && isNum(v.left) && isNum(v.top) && isNum(v.right) && isNum(v.bottom)

export function parseJournalEntry(v: unknown): JournalEntryShape | null {
  if (!isObj(v)) return null
  const hwnd = parseId(v.hwnd)
  const p = v.placement
  if (!hwnd || !isNum(v.pid) || !Number.isInteger(v.pid) || v.pid <= 0) return null
  if (!(v.startTime === null || (typeof v.startTime === 'string' && /^\d+$/.test(v.startTime)))) return null
  if (!isText(v.className, false) || !isNum(v.style) || !isNum(v.exStyle)) return null
  if (!isObj(p) || !isNum(p.length) || !isNum(p.flags) || !isNum(p.showCmd)) return null
  if (!isPoint(p.ptMinPosition) || !isPoint(p.ptMaxPosition) || !isWinRect(p.rcNormalPosition)) return null
  return {
    hwnd,
    pid: v.pid,
    startTime: v.startTime as string | null,
    className: v.className,
    style: v.style,
    exStyle: v.exStyle,
    placement: {
      length: p.length,
      flags: p.flags,
      showCmd: p.showCmd,
      ptMinPosition: { x: p.ptMinPosition.x, y: p.ptMinPosition.y },
      ptMaxPosition: { x: p.ptMaxPosition.x, y: p.ptMaxPosition.y },
      rcNormalPosition: { ...p.rcNormalPosition }
    }
  }
}

const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'opencode', 'cmd', 'pwsh']

/** A task becomes a program argument: one that starts with "-" would be read as a flag, quoted or not. */
export function startsLikeFlag(task: string): boolean {
  return task.trimStart().startsWith('-')
}
const MAX_TASK = 8000

/** A start request from the page. Workers are started only by another tile (spawn_worker), never from here. */
export function parseAgentStart(v: unknown): AgentStart | null {
  if (!isObj(v)) return null
  const provider = PROVIDERS.find((p) => p === v.provider)
  const role = v.role === 'orchestrator' || v.role === 'plain' ? v.role : null
  if (!provider || !role) return null
  // Absolute only: a drive path (C:\...) or a UNC path (\\server\share\...).
  if (typeof v.cwd !== 'string' || v.cwd.length > 1024 || !/^([a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+)/.test(v.cwd)) return null
  if (typeof v.task !== 'string' || v.task.length > MAX_TASK || startsLikeFlag(v.task)) return null
  return { provider, role, cwd: v.cwd, task: v.task }
}

export function parseTerminalSize(v: unknown): { cols: number; rows: number } | null {
  if (!isObj(v)) return null
  const ok = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 2 && n <= max
  return ok(v.cols, 1000) && ok(v.rows, 500) ? { cols: v.cols, rows: v.rows } : null
}
