// Real Win32 implementations of the capture/restore primitives.
// Reads are synchronous (they do not block on a hung window); every write goes through a worker thread.
import * as win from '../win32/windows'
import * as ax from '../win32/async'
import type { HWND } from '../win32/api'
import type { JournalEntry } from './journal'
import type { RestoreApi } from './restore'

const FRAME_ONLY = win.SWP_NOMOVE | win.SWP_NOSIZE | win.SWP_NOZORDER | win.SWP_NOACTIVATE | win.SWP_FRAMECHANGED

export const liveRestoreApi: RestoreApi = {
  isWindow: win.isWindow,
  getPid: win.getPid,
  processStartTime: win.processStartTime,
  getClassName: win.getClassName,
  clearOwner: (h) => ax.setWindowLong(h, win.GWLP_HWNDPARENT, 0),
  setStyle: (h, s) => ax.setWindowLong(h, win.GWL_STYLE, s),
  setExStyle: (h, s) => ax.setWindowLong(h, win.GWL_EXSTYLE, s),
  frameChanged: (h) => ax.setWindowPos(h, 0n, 0, 0, 0, 0, FRAME_ONLY),
  setPlacement: async (h, wp) => (await ax.setWindowPlacement(h, wp)) !== 0
}

/** Reads everything needed to undo a capture later. Null if the window is gone. */
export function snapshotOriginal(hwnd: HWND): JournalEntry | null {
  if (!win.isWindow(hwnd)) return null
  const placement = win.getPlacement(hwnd)
  if (!placement) return null
  const pid = win.getPid(hwnd)
  return {
    hwnd: hwnd.toString(),
    pid,
    startTime: win.processStartTime(pid),
    className: win.getClassName(hwnd),
    style: win.getStyle(hwnd),
    exStyle: win.getExStyle(hwnd),
    placement
  }
}

/** Turns a normal top-level window into a frameless tool window that the app positions. */
export async function adoptWindow(hwnd: HWND, original: JournalEntry): Promise<void> {
  // Minimized or maximized windows first return to their normal state. SW_SHOWNOACTIVATE would
  // keep a maximized window maximized ("most recent size"), so this has to be SW_SHOWNORMAL.
  if (original.placement.showCmd !== win.SW_SHOWNORMAL) {
    await ax.setWindowPlacement(hwnd, { ...original.placement, showCmd: win.SW_SHOWNORMAL })
  }
  // Read the style fresh: the journaled one still carries WS_MAXIMIZE/WS_MINIMIZE, and writing
  // it back would re-maximize/re-minimize the window.
  const style = win.getStyle(hwnd)
  const exStyle = win.getExStyle(hwnd)
  await ax.setWindowLong(hwnd, win.GWL_STYLE, style & ~(win.WS_CAPTION | win.WS_THICKFRAME))
  await ax.setWindowLong(hwnd, win.GWL_EXSTYLE, (exStyle | win.WS_EX_TOOLWINDOW) & ~win.WS_EX_APPWINDOW)
  await ax.setWindowPos(hwnd, 0n, 0, 0, 0, 0, FRAME_ONLY)
}

export function setOwner(hwnd: HWND, owner: HWND | 0n): Promise<number | bigint> {
  return ax.setWindowLong(hwnd, win.GWLP_HWNDPARENT, owner)
}
