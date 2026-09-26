// Owns the set of captured windows: capture, release, liveness and titles.
// Every capture is journaled BEFORE the window is touched; every release goes through restoreEntry.
import { EventEmitter } from 'node:events'
import type { CaptureResult } from '../../shared/types'
import type { HWND } from '../win32/api'
import { isHung } from '../win32/async'
import * as win from '../win32/windows'
import { Journal } from './journal'
import { adoptWindow, liveRestoreApi, snapshotOriginal } from './live'
import { WindowOps } from './ops'
import { restoreEntry, type RestoreOutcome } from './restore'

export type Session = {
  id: string
  hwnd: HWND
  className: string
  processName: string
  title: string
}

export type SessionManagerOptions = {
  /** The app's own top-level windows; they can never be captured. */
  ownWindows: () => HWND[]
  selfElevated: boolean
  /** Injectable for tests; defaults to the real token check. */
  isElevated?: (pid: number) => boolean
  /** True when another running organizer instance holds this window (it is in that journal). */
  claimedElsewhere?: (id: string) => boolean
}

type Refusal = Exclude<CaptureResult, { ok: true }>

export class SessionManager extends EventEmitter<{ changed: []; removed: [id: string] }> {
  private readonly sessions = new Map<string, Session>()
  private readonly capturing = new Set<string>()
  /** Windows being restored right now: not capturable until the restore finished (cold review, race). */
  private readonly releasing = new Set<string>()
  readonly ops = new WindowOps()

  constructor(
    private readonly journal: Journal,
    private readonly opts: SessionManagerOptions
  ) {
    super()
  }

  list(): Session[] {
    return [...this.sessions.values()]
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  canCapture(hwnd: HWND): Refusal | null {
    if (!win.isWindow(hwnd)) return { ok: false, reason: 'gone' }
    if (win.rootOf(hwnd) !== hwnd) return { ok: false, reason: 'unsupported' }
    const id = hwnd.toString()
    if (this.sessions.has(id) || this.capturing.has(id) || this.releasing.has(id)) return { ok: false, reason: 'already' }
    if (this.opts.claimedElsewhere?.(id)) return { ok: false, reason: 'other-instance' }
    if (this.opts.ownWindows().includes(hwnd)) return { ok: false, reason: 'unsupported' }
    if (!win.isConsoleWindow(hwnd) || !win.isVisible(hwnd)) return { ok: false, reason: 'unsupported' }
    const elevated = this.opts.isElevated ?? win.isProcessElevated
    if (!this.opts.selfElevated && elevated(win.getPid(hwnd))) return { ok: false, reason: 'elevated' }
    if (isHung(hwnd)) return { ok: false, reason: 'failed' }
    return null
  }

  async capture(hwnd: HWND): Promise<CaptureResult> {
    const refused = this.canCapture(hwnd)
    if (refused) return refused
    const original = snapshotOriginal(hwnd)
    if (!original) return { ok: false, reason: 'gone' }
    const id = original.hwnd

    this.capturing.add(id)
    try {
      this.journal.add(original) // must hit the disk before the window is modified
      try {
        await this.ops.run(id, () => adoptWindow(hwnd, original))
      } catch {
        const rollback = await this.ops.run(id, () => restoreEntry(original, liveRestoreApi))
        // A half-adopted window that could not be rolled back stays journaled for the watchdog / next start.
        if (rollback !== 'failed') this.journal.remove(id)
        return { ok: false, reason: 'failed' }
      }
      this.sessions.set(id, {
        id,
        hwnd,
        className: original.className,
        processName: win.processImageName(original.pid) ?? original.className,
        title: win.getTitle(hwnd)
      })
    } finally {
      this.capturing.delete(id)
    }
    this.emit('changed')
    return { ok: true, id }
  }

  async release(id: string): Promise<RestoreOutcome | 'unknown' | 'already'> {
    // A restore already running for this window finishes on its own; a second one queued behind it
    // could run after another instance took the window over and undo that capture (cold review).
    if (this.releasing.has(id)) {
      await this.ops.idle(id)
      return 'already'
    }
    const entry = this.journal.entries().find((e) => e.hwnd === id)
    const had = this.sessions.delete(id)
    if (had) this.emitRemoved(id)
    if (!entry) return 'unknown'
    this.releasing.add(id)
    try {
      const outcome = await this.ops.run(id, () => restoreEntry(entry, liveRestoreApi))
      // A window that stays hung keeps its journal entry, so the watchdog or next start retries it.
      if (outcome !== 'failed') this.journal.remove(id)
      return outcome
    } finally {
      this.releasing.delete(id)
    }
  }

  async releaseAll(): Promise<void> {
    const ids = new Set([...this.sessions.keys(), ...this.journal.entries().map((e) => e.hwnd)])
    await Promise.all([...ids].map((id) => this.release(id)))
  }

  /** Polls liveness and titles. Closed windows leave the set and the journal. */
  refresh(): void {
    let changed = false
    for (const s of [...this.sessions.values()]) {
      if (!win.isWindow(s.hwnd)) {
        this.sessions.delete(s.id)
        this.journal.remove(s.id)
        this.emitRemoved(s.id)
        continue
      }
      const title = win.getTitle(s.hwnd)
      if (title !== s.title) {
        s.title = title
        changed = true
      }
    }
    if (changed) this.emit('changed')
  }

  private emitRemoved(id: string): void {
    this.emit('removed', id)
    this.emit('changed')
  }
}

/**
 * Restores windows left behind by a crashed previous run. Entries that failed stay journaled.
 * A hung window is skipped (and stays journaled): waiting on it would block the whole app start.
 */
export async function recoverOrphans(journal: Journal): Promise<Array<RestoreOutcome | 'hung'>> {
  return Promise.all(
    journal.entries().map(async (e): Promise<RestoreOutcome | 'hung'> => {
      if (isHung(BigInt(e.hwnd))) return 'hung'
      const outcome = await restoreEntry(e, liveRestoreApi)
      if (outcome !== 'failed') journal.remove(e.hwnd)
      return outcome
    })
  )
}
