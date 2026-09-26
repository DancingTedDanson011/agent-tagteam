// Runs the activity state machine for every captured window once per second and owns the badges.
import type { Activity } from '../../shared/types'
import type { Session } from '../capture/sessions'
import { isHung } from '../win32/async'
import { snapshotWindow } from '../win32/snapshot'
import { DEFAULT_ACTIVITY_CONFIG, initialActivity, parseTitleHint, step, type ActivityState } from './activity'
import { blockHashes, countChanged, type FrameHashes } from './frames'

/** After a resize the terminal reflows for a moment; that is layout, not work. */
const SETTLE_MS = 1500

export type MonitorDeps = {
  sessions: () => Session[]
  isAttended: (s: Session) => boolean
  /** True while captured windows are hidden (app minimized): no pixels to compare. */
  paused: () => boolean
  now?: () => number
}

export class ActivityMonitor {
  private readonly states = new Map<string, ActivityState>()
  private readonly frames = new Map<string, FrameHashes>()
  private readonly settleUntil = new Map<string, number>()
  private readonly badges = new Set<string>()
  private readonly awayFrames = new Map<string, FrameHashes>()
  private running = false

  constructor(private readonly deps: MonitorDeps) {}

  info(id: string): { activity: Activity; badge: boolean } {
    return { activity: this.states.get(id)?.activity ?? 'idle', badge: this.badges.has(id) }
  }

  clearBadge(id: string): void {
    this.badges.delete(id)
  }

  settle(id: string): void {
    this.settleUntil.set(id, this.now() + SETTLE_MS)
    this.frames.delete(id)
  }

  forget(id: string): void {
    this.states.delete(id)
    this.frames.delete(id)
    this.settleUntil.delete(id)
    this.badges.delete(id)
    this.awayFrames.delete(id)
  }

  /** Remember the last frame before the app hides everything, to compare after it comes back. */
  markAway(): void {
    for (const [id, f] of this.frames) this.awayFrames.set(id, f)
  }

  /** One pass over all sessions. Returns true when any visible state (activity/badge) changed. */
  async tick(): Promise<boolean> {
    if (this.running) return false
    this.running = true
    try {
      let changed = false
      for (const s of this.deps.sessions()) {
        const before = JSON.stringify(this.info(s.id))
        await this.tickOne(s)
        if (JSON.stringify(this.info(s.id)) !== before) changed = true
      }
      return changed
    } finally {
      this.running = false
    }
  }

  private async tickOne(s: Session): Promise<void> {
    const now = this.now()
    const titleHint = parseTitleHint(s.title)
    let changedBlocks: number | null = null

    if (titleHint === null && !this.deps.paused() && !isHung(s.hwnd) && now >= (this.settleUntil.get(s.id) ?? 0)) {
      const snap = await snapshotWindow(s.hwnd)
      if (snap) {
        const cur = blockHashes(snap.bgra, snap.width, snap.height)
        const prev = this.frames.get(s.id)
        changedBlocks = prev ? countChanged(prev, cur) : null
        this.frames.set(s.id, cur)

        const away = this.awayFrames.get(s.id)
        if (away) {
          this.awayFrames.delete(s.id)
          const n = countChanged(away, cur)
          if (n !== null && n > DEFAULT_ACTIVITY_CONFIG.changeThreshold && !this.deps.isAttended(s)) this.badges.add(s.id)
        }
      }
    }

    const r = step(this.states.get(s.id) ?? initialActivity(), { now, changedBlocks, titleHint }, DEFAULT_ACTIVITY_CONFIG)
    this.states.set(s.id, r.state)
    const attended = this.deps.isAttended(s)
    if (attended) this.badges.delete(s.id)
    else if (r.becameWaiting) this.badges.add(s.id)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
