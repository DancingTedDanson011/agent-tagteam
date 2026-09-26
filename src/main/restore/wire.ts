// IPC for names/colours of sessions and for workspaces that bring their windows back.
// Everything from the page or from workspaces.json is parsed again here before it is used.
import { ipcMain } from 'electron'
import { parseColorId, parseLabel, parseSlotLaunch } from '../../shared/restore'
import type { AgentStart, CaptureResult, RestoreResult, SessionInfo, SessionStyle, SlotLaunch } from '../../shared/types'
import { parseIdList, parseSessionId } from '../../shared/validate'
import type { StartResult } from '../agents/agents'
import type { HWND } from '../win32/api'
import { processCwd } from '../win32/process-cwd'
import * as win from '../win32/windows'
import { describeSession } from './recipe'
import { startWindow, waitForNewWindow, windowClassOf } from './relaunch'

const WINDOW_TIMEOUT_MS = 15000
const SETTLE_MS = 400 // a window that just appeared finishes its first layout before it is captured

type Deps = {
  captured(id: string): { hwnd: HWND; processName: string; className: string; title: string } | undefined
  capture(h: HWND): Promise<CaptureResult>
  agentInfos(): SessionInfo[]
  startAgent(start: AgentStart): StartResult
  home: string
  isDir(p: string): boolean
  push(): void
}

export type RestoreWiring = {
  /** Adds the user's name and colour to every session info; drops styles of sessions that are gone. */
  decorate(infos: SessionInfo[]): SessionInfo[]
}

function parseStyle(v: unknown): SessionStyle | null {
  if (typeof v !== 'object' || v === null) return null
  const raw = v as Record<string, unknown>
  const label = parseLabel(raw.label ?? '')
  if (label === null) return null
  const color = raw.color === undefined || raw.color === null ? undefined : parseColorId(raw.color)
  if (color === null) return null
  return { ...(label ? { label } : {}), ...(color ? { color } : {}) }
}

export function wireRestore(deps: Deps): RestoreWiring {
  const styles = new Map<string, SessionStyle>()
  let queue: Promise<unknown> = Promise.resolve()

  ipcMain.on('session:style', (_e, rawId, rawStyle) => {
    const id = parseSessionId(rawId)
    const style = parseStyle(rawStyle)
    if (!id || !style) return
    if (style.label || style.color) styles.set(id, style)
    else styles.delete(id)
    deps.push()
  })

  ipcMain.handle('workspaces:describe', (_e, rawIds): { home: string; recipes: Record<string, SlotLaunch | null> } => {
    const ids = parseIdList(rawIds) ?? []
    const agents = new Map(deps.agentInfos().map((a) => [a.id, a]))
    const out: Record<string, SlotLaunch | null> = {}
    for (const id of ids) {
      const agent = agents.get(id)?.agent
      if (agent) {
        out[id] = describeSession({ processName: agent.provider, className: 'agent', title: '', agent }, () => null)
        continue
      }
      const s = deps.captured(id)
      out[id] = s ? describeSession(s, () => processCwd(win.getPid(s.hwnd))) : null
    }
    return { home: deps.home, recipes: out }
  })

  const restore = async (launch: SlotLaunch, style: SessionStyle, resume: boolean): Promise<RestoreResult> => {
    const known = launch.cwd !== null && deps.isDir(launch.cwd)
    const cwd = known ? (launch.cwd as string) : deps.home
    const done = (id: string): RestoreResult => {
      if (style.label || style.color) styles.set(id, style)
      deps.push()
      return { ok: true, id, homeFallback: !known }
    }
    if (launch.kind === 'agent') {
      const r = deps.startAgent({ provider: launch.provider, role: launch.role, cwd, task: '', resume })
      return r.ok ? done(r.id) : { ok: false, reason: 'failed' }
    }
    const before = new Set(win.listTopLevelWindows())
    const ours = startWindow(launch, cwd, style, resume)
    if (!ours) return { ok: false, reason: 'failed' }
    const h = await waitForNewWindow(before, windowClassOf(launch), ours, WINDOW_TIMEOUT_MS)
    if (!h) return { ok: false, reason: 'timeout' }
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    const captured = await deps.capture(h)
    return captured.ok ? done(captured.id) : { ok: false, reason: 'failed' }
  }

  // One slot at a time: "the new window" is only unambiguous while nothing else is being started.
  ipcMain.handle('workspaces:restore', (_e, rawSlot, rawResume): Promise<RestoreResult> => {
    const slot = typeof rawSlot === 'object' && rawSlot !== null ? (rawSlot as Record<string, unknown>) : {}
    const launch = parseSlotLaunch(slot.launch)
    if (!launch) return Promise.resolve({ ok: false, reason: 'no-launch' })
    const style = parseStyle({ label: slot.label, color: slot.color }) ?? {}
    const run = queue.then(() => restore(launch, style, rawResume === true))
    queue = run.catch(() => undefined)
    return run.catch((): RestoreResult => ({ ok: false, reason: 'failed' }))
  })

  return {
    decorate: (infos) => {
      const live = new Set(infos.map((i) => i.id))
      for (const id of styles.keys()) if (!live.has(id)) styles.delete(id)
      return infos.map((i) => ({ ...i, ...styles.get(i.id) }))
    }
  }
}
