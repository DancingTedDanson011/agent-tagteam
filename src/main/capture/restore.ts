// Puts a captured window back into the state recorded in the journal.
// Pure decision logic over an injected API, so it runs the same in the app, the watchdog and tests.
import type { HWND, WindowPlacement } from '../win32/api'
import type { JournalEntry } from './journal'

type Step = void | Promise<unknown>

export type RestoreApi = {
  isWindow(h: HWND): boolean
  getPid(h: HWND): number
  processStartTime(pid: number): string | null
  getClassName(h: HWND): string
  /** Removes the owner link to the app window (GWLP_HWNDPARENT = 0). */
  clearOwner(h: HWND): Step
  setStyle(h: HWND, style: number): Step
  setExStyle(h: HWND, exStyle: number): Step
  /** Re-evaluates the non-client frame after a style change (SetWindowPos + SWP_FRAMECHANGED). */
  frameChanged(h: HWND): Step
  setPlacement(h: HWND, wp: WindowPlacement): boolean | Promise<boolean>
}

export type RestoreOutcome = 'restored' | 'gone' | 'mismatch' | 'failed'

const SW_SHOWNORMAL = 1
const SW_SHOWNOACTIVATE = 4

/** The HWND still names the window we captured (not a reused handle of another window). */
export function sameWindow(entry: JournalEntry, api: RestoreApi): boolean | 'gone' {
  const h = BigInt(entry.hwnd)
  if (!api.isWindow(h)) return 'gone'
  if (api.getPid(h) !== entry.pid) return false
  if (api.getClassName(h) !== entry.className) return false
  if (entry.startTime !== null && api.processStartTime(entry.pid) !== entry.startTime) return false
  return true
}

export async function restoreEntry(entry: JournalEntry, api: RestoreApi): Promise<RestoreOutcome> {
  try {
    const same = sameWindow(entry, api)
    if (same === 'gone') return 'gone'
    if (!same) return 'mismatch'
    const h = BigInt(entry.hwnd)
    const showCmd = entry.placement.showCmd === SW_SHOWNORMAL ? SW_SHOWNOACTIVATE : entry.placement.showCmd
    await api.clearOwner(h)
    await api.setStyle(h, entry.style)
    await api.setExStyle(h, entry.exStyle)
    await api.frameChanged(h)
    return (await api.setPlacement(h, { ...entry.placement, showCmd })) ? 'restored' : 'failed'
  } catch {
    return 'failed'
  }
}
