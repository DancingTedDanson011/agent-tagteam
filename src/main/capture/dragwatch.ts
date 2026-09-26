// Polls mouse and foreground window to detect a console window being dropped onto the app.
import type { BrowserWindow } from 'electron'
import { screen } from 'electron'
import { containsPoint } from '../../shared/geometry'
import type { DragKind, DragState } from '../../shared/types'
import * as w from '../win32/api'
import type { HWND } from '../win32/api'
import * as win from '../win32/windows'
import { initialDrag, stepDrag, type DragMachine } from './drag'

const POLL_MS = 50
const SM_SWAPBUTTON = 23
const VK_LBUTTON = 0x01
const VK_RBUTTON = 0x02

export type DragWatchDeps = {
  appWindow: BrowserWindow
  eligible: (h: HWND) => boolean
  /** A window this app has captured (dropping it back onto the app puts it back in its slot). */
  captured: (h: HWND) => boolean
  /** A window of another organizer instance: when it covers this app at the cursor, the drop is its. */
  rival: (h: HWND) => boolean
  onState: (s: DragState) => void
  onDrop: (h: HWND, kind: DragKind) => void
}

export class DragWatcher {
  private machine: DragMachine = initialDrag()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: DragWatchDeps) {}

  start(): void {
    this.timer ??= setInterval(() => this.poll(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private poll(): void {
    const app = this.deps.appWindow
    if (app.isDestroyed()) return this.stop()
    // The title bar is dragged with the primary button, which is the physical right one when swapped.
    const vk = w.GetSystemMetrics(SM_SWAPBUTTON) !== 0 ? VK_RBUTTON : VK_LBUTTON
    const buttonDown = (w.GetAsyncKeyState(vk) & 0x8000) !== 0
    const fgHandle = w.GetForegroundWindow() as HWND | null
    const rect = fgHandle ? win.getRect(fgHandle) : null
    const fg =
      fgHandle && rect
        ? { id: fgHandle.toString(), rect, eligible: this.deps.eligible(fgHandle), captured: this.deps.captured(fgHandle) }
        : null

    let cursorOverApp = false
    if (app.isVisible() && !app.isMinimized()) {
      const area = screen.dipToScreenRect(app, app.getContentBounds())
      const cursor = win.cursorPos()
      if (containsPoint(area, cursor)) {
        // Two overlapping organizers must not both grab the same drop: the one on top at the cursor
        // takes it. This app's own live terminals lie on top of it and belong to it.
        const self = app.getNativeWindowHandle().readBigUInt64LE()
        const top = win.windowAt(cursor, (h) => h !== fgHandle && (h === self || this.deps.captured(h) || this.deps.rival(h)))
        cursorOverApp = top === null || !this.deps.rival(top)
      }
    }

    const r = stepDrag(this.machine, { buttonDown, fg, cursorOverApp })
    this.machine = r.machine
    if (r.emit) this.deps.onState(r.emit)
    if (r.drop && r.dropKind) this.deps.onDrop(BigInt(r.drop), r.dropKind)
  }
}
