// Moves captured windows to match the renderer's layout.
//  live   -> owned by the app window (stays above it, no flicker), positioned over its slot
//  thumb  -> not owned, parked right below the app window, shown as a DWM live thumbnail
//  parked -> not owned, parked right below the app window, nothing drawn
// Parked windows keep a real size so terminals do not reflow and PrintWindow keeps working.
import type { BrowserWindow } from 'electron'
import { screen } from 'electron'
import { clampSize, clipThumbnail, fitAspect, isDisplaced, offsetRect, scaleRect, type Box, type Size } from '../../shared/geometry'
import type { Layout, SlotPlacement } from '../../shared/types'
import type { SessionManager } from '../capture/sessions'
import { setOwner } from '../capture/live'
import * as ax from '../win32/async'
import type { HWND } from '../win32/api'
import * as w from '../win32/api'
import * as win from '../win32/windows'
import type { Thumbnails } from './thumbs'

const MOVE = win.SWP_NOACTIVATE | win.SWP_SHOWWINDOW
const ZORDER_ONLY = win.SWP_NOMOVE | win.SWP_NOSIZE | win.SWP_NOACTIVATE

export type PlacerHooks = { sizeChanged(id: string): void }

export class Placer {
  private layout: Layout = { placements: [], attended: [] }
  private readonly owned = new Set<string>()
  private readonly liveSize = new Map<string, Size>()
  private readonly lastBox = new Map<string, string>()
  /** Where each live window should be (screen pixels) — to notice when the user drags it away. */
  private readonly liveBox = new Map<string, Box>()
  private hidden = false

  constructor(
    private readonly win: BrowserWindow,
    private readonly sessions: SessionManager,
    private readonly thumbs: Thumbnails,
    private readonly hooks: PlacerHooks
  ) {}

  appHwnd(): HWND {
    return this.win.getNativeWindowHandle().readBigUInt64LE()
  }

  current(): Layout {
    return this.layout
  }

  isHidden(): boolean {
    return this.hidden
  }

  /** True while the window is shown over its slot (not parked behind the app, not hidden). */
  isLive(id: string): boolean {
    return !this.hidden && this.owned.has(id)
  }

  setLayout(layout: Layout): void {
    this.layout = layout
    this.apply()
  }

  /** Re-applies the current layout (after the app window moved or resized). */
  apply(): void {
    if (this.hidden || this.win.isDestroyed() || this.win.isMinimized()) return
    const content = this.win.getContentBounds()
    const scale = screen.getDisplayMatching(this.win.getBounds()).scaleFactor
    const contentScreen = screen.dipToScreenRect(this.win, content)
    const byId = new Map(this.layout.placements.map((p) => [p.id, p]))
    const thumbIds = new Set<string>()

    for (const s of this.sessions.list()) {
      // An open dialog must never be covered: every window parks behind the app, whatever the view lists.
      const p: SlotPlacement = (!this.layout.modal && byId.get(s.id)) || { id: s.id, mode: 'parked' }
      if (p.mode === 'live') {
        const box = screen.dipToScreenRect(this.win, offsetRect(content, p.rect))
        this.placeLive(s.id, s.hwnd, box)
        this.thumbs.remove(s.id)
        if (p.mirror) {
          // The big window also stays visible in the side list, as a live preview of itself.
          const key = `${s.id}#mirror`
          const dest = scaleRect(fitAspect(p.mirror, box.width, box.height), scale)
          const cut = p.clip ? clipThumbnail(dest, scaleRect(p.clip, scale), box.width, box.height) : { dest, source: undefined }
          if (cut && this.thumbs.set(key, s.hwnd, cut.dest, cut.source)) thumbIds.add(key)
        }
      } else {
        const size = clampSize(this.liveSize.get(s.id) ?? contentScreen, contentScreen)
        this.placeParked(s.id, s.hwnd, { x: contentScreen.x, y: contentScreen.y, ...size })
        if (p.mode === 'thumb') {
          const dest = scaleRect(fitAspect(p.rect, size.width, size.height), scale)
          // DWM ignores CSS clipping: cut the thumbnail to the visible part of its scroll list.
          const cut = p.clip ? clipThumbnail(dest, scaleRect(p.clip, scale), size.width, size.height) : { dest, source: undefined }
          if (cut && this.thumbs.set(s.id, s.hwnd, cut.dest, cut.source)) thumbIds.add(s.id)
        }
      }
    }
    this.thumbs.keepOnly(thumbIds)
  }

  private placeLive(id: string, hwnd: HWND, box: Box): void {
    const app = this.appHwnd()
    if (!this.owned.has(id)) {
      this.owned.add(id)
      void this.sessions.ops.run(id, async () => {
        await setOwner(hwnd, app)
        // Put the app window directly below its new owned window, so the owned one shows at once.
        w.SetWindowPos(app, hwnd, 0, 0, 0, 0, ZORDER_ONLY)
      })
    }
    this.liveSize.set(id, { width: box.width, height: box.height })
    this.liveBox.set(id, box)
    this.move(id, hwnd, 0n, box, win.SWP_NOZORDER)
  }

  private placeParked(id: string, hwnd: HWND, box: Box): void {
    this.liveBox.delete(id)
    if (this.owned.delete(id)) void this.sessions.ops.run(id, () => setOwner(hwnd, 0n))
    this.move(id, hwnd, this.appHwnd(), box, 0)
  }

  private move(id: string, hwnd: HWND, after: HWND, box: Box, extra: number): void {
    const key = `${after}|${box.x},${box.y},${box.width},${box.height}`
    if (this.lastBox.get(id) === key) return
    const prev = this.lastBox.get(id)
    this.lastBox.set(id, key)
    const sizeKey = (k: string | undefined) => k?.split(',').slice(2).join(',')
    if (sizeKey(prev) !== sizeKey(key)) this.hooks.sizeChanged(id)
    if (ax.isHung(hwnd)) {
      this.lastBox.delete(id) // retry on the next apply
      return
    }
    this.sessions.ops.coalesce(id, () => ax.setWindowPos(hwnd, after, box.x, box.y, box.width, box.height, MOVE | extra))
  }

  /** The app was minimized: hide every captured window (the journal still knows how to restore them). */
  hideAll(): void {
    if (this.hidden) return
    this.hidden = true
    this.thumbs.clear()
    for (const s of this.sessions.list()) {
      void this.sessions.ops.run(s.id, () => ax.showWindow(s.hwnd, win.SW_HIDE))
    }
    this.lastBox.clear()
  }

  showAll(): void {
    if (!this.hidden) return
    this.hidden = false
    for (const s of this.sessions.list()) {
      void this.sessions.ops.run(s.id, () => ax.showWindow(s.hwnd, win.SW_SHOWNOACTIVATE))
    }
    this.apply()
  }

  /**
   * Live windows the user moved, resized, maximized or minimized away from their slot (a Windows
   * Terminal can be dragged by its own tab bar). Windows with a placement still in flight are not
   * judged yet — they are on their way.
   */
  displacedIds(): string[] {
    if (this.hidden) return []
    return this.sessions
      .list()
      .filter((s) => {
        const box = this.liveBox.get(s.id)
        if (!box || !this.owned.has(s.id) || this.sessions.ops.pending(s.id)) return false
        return win.isMinimized(s.hwnd) || w.IsZoomed(s.hwnd) !== 0 || isDisplaced(win.getRect(s.hwnd), box)
      })
      .map((s) => s.id)
  }

  /**
   * While a dialog is open every captured window is parked below the app. If one of them still
   * comes to the front (Alt+Tab, a click that reached it), park it again. Returns true when it did,
   * so the caller brings the app window back to the front.
   */
  guardModal(foreground: HWND | null): boolean {
    if (!this.layout.modal || foreground === null) return false
    const s = this.sessions.list().find((x) => x.hwnd === foreground)
    if (!s) return false
    this.lastBox.delete(s.id)
    this.apply()
    return true
  }

  /** Puts windows back into their slots even though the layout did not change (all when no ids). */
  reseat(ids?: string[]): void {
    for (const s of this.sessions.list()) {
      if (ids && !ids.includes(s.id)) continue
      this.lastBox.delete(s.id)
      if (win.isMinimized(s.hwnd) || w.IsZoomed(s.hwnd) !== 0) {
        const placement = win.getPlacement(s.hwnd)
        if (placement) {
          void this.sessions.ops.run(s.id, () => ax.setWindowPlacement(s.hwnd, { ...placement, showCmd: win.SW_SHOWNORMAL }))
        }
      }
    }
    this.apply()
  }

  forget(id: string): void {
    this.owned.delete(id)
    this.liveSize.delete(id)
    this.liveBox.delete(id)
    this.lastBox.delete(id)
    this.thumbs.remove(id)
  }

  /** Detaches all owned windows; used before the app window is destroyed. */
  async detachAll(): Promise<void> {
    this.thumbs.clear()
    await Promise.all(
      this.sessions.list().map((s) =>
        this.owned.delete(s.id) ? this.sessions.ops.run(s.id, () => setOwner(s.hwnd, 0n)) : Promise.resolve()
      )
    )
  }
}
