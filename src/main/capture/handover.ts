// Moving a terminal from one organizer instance to another. The taker writes a request file into the
// shared data folder; the holder releases the window (its original comes back), then the taker
// captures it the normal way — so the taker journals the real original, never the adopted state.
// A request can make the holder do exactly one thing: release that window.
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Journal } from './journal'
import { listJournals } from './instances'

const REQUEST = /^handover-(\d{1,20})\.json$/

export type Requester = { pid: number; start: string }

const requestPath = (dataDir: string, hwnd: string) => join(dataDir, `handover-${hwnd}.json`)

export function requestHandover(dataDir: string, hwnd: string, from: Requester): void {
  const file = requestPath(dataDir, hwnd)
  writeFileSync(file + '.tmp', JSON.stringify(from))
  renameSync(file + '.tmp', file)
}

export function clearHandover(dataDir: string, hwnd: string): void {
  rmSync(requestPath(dataDir, hwnd), { force: true })
}

function readRequester(file: string): Requester | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; start?: unknown }
    return typeof v.pid === 'number' && Number.isInteger(v.pid) && typeof v.start === 'string' && /^[A-Za-z0-9]+$/.test(v.start)
      ? { pid: v.pid, start: v.start }
      : null
  } catch {
    return null
  }
}

/**
 * Window ids the caller holds (`mine`) that a live instance asked for. Requests of an instance that
 * is gone are deleted: nobody would pick the released window up.
 */
export function handoversFor(dataDir: string, mine: (id: string) => boolean, isAlive: (pid: number, start: string) => boolean): string[] {
  let names: string[]
  try {
    names = readdirSync(dataDir)
  } catch {
    return []
  }
  const ids: string[] = []
  for (const name of names) {
    const m = REQUEST.exec(name)
    if (!m || !mine(m[1])) continue
    const from = readRequester(join(dataDir, name))
    if (from && isAlive(from.pid, from.start)) ids.push(m[1])
    else rmSync(join(dataDir, name), { force: true })
  }
  return ids
}

/**
 * Who else holds `id`: a running instance of this version (it answers a handover request), an
 * instance that is gone (its window is not restored yet — the watchdog or the next start does that),
 * an older single-instance version (it cannot answer), or nobody.
 */
export function claimKind(
  dataDir: string,
  self: string,
  id: string,
  isAlive: (pid: number, start: string) => boolean
): 'instance' | 'stale' | 'legacy' | null {
  for (const j of listJournals(dataDir)) {
    if (j.file === self || !Journal.read(j.file).some((e) => e.hwnd === id)) continue
    if (j.pid === null || j.start === null) return 'legacy'
    return isAlive(j.pid, j.start) ? 'instance' : 'stale'
  }
  return null
}

/** Polls until `claimed()` turns false (true) or the time is up (false). */
export async function awaitRelease(claimed: () => boolean, timeoutMs: number, pollMs = 100): Promise<boolean> {
  const until = Date.now() + timeoutMs
  for (;;) {
    if (!claimed()) return true
    if (Date.now() >= until) return false
    await new Promise((r) => setTimeout(r, pollMs))
  }
}
