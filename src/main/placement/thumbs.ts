// Live DWM thumbnails of parked windows, drawn onto the app window (focus view side column).
// DWM composes them above the web content, so the renderer keeps those areas free of UI.
import type { Box } from '../../shared/geometry'
import * as w from '../win32/api'
import type { HWND } from '../win32/api'

const DWM_TNP_RECTDESTINATION = 0x1
const DWM_TNP_RECTSOURCE = 0x2
const DWM_TNP_OPACITY = 0x4
const DWM_TNP_VISIBLE = 0x8
const DWM_TNP_SOURCECLIENTAREAONLY = 0x10

type Placed = { dest: Box; source?: Box }
type Entry = { thumb: unknown; src: HWND; dest: string; placed?: Placed }

export class Thumbnails {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly appHwnd: () => HWND) {}

  /**
   * Shows the thumbnail of `src` at `dest` (device pixels, relative to the app's client area).
   * `source` limits it to that part of the source window (a thumbnail partly scrolled out of view).
   */
  set(id: string, src: HWND, dest: Box, source?: Box): boolean {
    let e = this.entries.get(id)
    if (e && e.src !== src) {
      this.remove(id)
      e = undefined
    }
    if (!e) {
      const out = [null as unknown]
      if (w.DwmRegisterThumbnail(this.appHwnd(), src, out) !== 0 || !out[0]) return false
      e = { thumb: out[0], src, dest: '' }
      this.entries.set(id, e)
    }
    const sourceKey = source ? `|${source.x},${source.y},${source.width},${source.height}` : ''
    const key = `${dest.x},${dest.y},${dest.width},${dest.height}${sourceKey}`
    if (e.dest === key) return true
    const props = {
      dwFlags:
        DWM_TNP_RECTDESTINATION |
        DWM_TNP_OPACITY |
        DWM_TNP_VISIBLE |
        DWM_TNP_SOURCECLIENTAREAONLY |
        (source ? DWM_TNP_RECTSOURCE : 0),
      rcDestination: { left: dest.x, top: dest.y, right: dest.x + dest.width, bottom: dest.y + dest.height },
      rcSource: source
        ? { left: source.x, top: source.y, right: source.x + source.width, bottom: source.y + source.height }
        : { left: 0, top: 0, right: 0, bottom: 0 },
      opacity: 255,
      fVisible: 1,
      fSourceClientAreaOnly: 0
    }
    const ok = w.DwmUpdateThumbnailProperties(e.thumb, props) === 0
    if (ok) {
      e.dest = key
      e.placed = { dest, source }
    }
    return ok
  }

  remove(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    w.DwmUnregisterThumbnail(e.thumb)
    this.entries.delete(id)
  }

  keepOnly(ids: Set<string>): void {
    for (const id of [...this.entries.keys()]) if (!ids.has(id)) this.remove(id)
  }

  /** Where the thumbnail was last drawn (device pixels), for the selftest. */
  placed(id: string): Placed | undefined {
    return this.entries.get(id)?.placed
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  clear(): void {
    this.keepOnly(new Set())
  }
}
