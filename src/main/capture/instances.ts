// Several organizer instances may run side by side. Each keeps its own restore journal, named after
// its process id and start time, so a crash of one never touches the windows of another:
//  - on start, an instance recovers only journals whose owner is dead (a reused PID counts as dead);
//  - no instance captures a window that is in another instance's journal.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Journal } from './journal'

const INSTANCE_JOURNAL = /^restore-journal-(\d+)-([A-Za-z0-9]+)\.json$/
/**
 * Written by versions before multi-instance support. Its owner is not in the name; such a version
 * may still be running next to a new one (it holds the old single-instance lock), so the caller
 * says whether it does. A legacy journal of a running owner is live like any other.
 */
const LEGACY_JOURNAL = 'restore-journal.json'

export type Liveness = {
  /** True while the process `pid` with creation time `start` still runs. */
  isAlive: (pid: number, start: string) => boolean
  /** True while an older, single-instance version runs. */
  legacyAlive: boolean
}

export type JournalFile = { file: string; pid: number | null; start: string | null }

export function instanceJournalPath(dataDir: string, pid: number, start: string): string {
  return join(dataDir, `restore-journal-${pid}-${start}.json`)
}

export function listJournals(dataDir: string): JournalFile[] {
  let names: string[]
  try {
    names = readdirSync(dataDir)
  } catch {
    return []
  }
  return names.flatMap((name): JournalFile[] => {
    if (name === LEGACY_JOURNAL) return [{ file: join(dataDir, name), pid: null, start: null }]
    const m = INSTANCE_JOURNAL.exec(name)
    return m ? [{ file: join(dataDir, name), pid: Number(m[1]), start: m[2] }] : []
  })
}

const ownerAlive = (j: JournalFile, live: Liveness) =>
  j.pid === null || j.start === null ? live.legacyAlive : live.isAlive(j.pid, j.start)

/** Journals left behind by instances that no longer run — never `self`. */
export function journalsOfDeadInstances(dataDir: string, self: string, live: Liveness): string[] {
  return listJournals(dataDir)
    .filter((j) => j.file !== self && !ownerAlive(j, live))
    .map((j) => j.file)
}

/**
 * Window handles in any other instance's journal. A dead instance's windows count too: until its
 * watchdog or the next start restored them they are still frameless, and capturing one would record
 * that adopted state as its "original" (cold review).
 */
export function claimedByOtherInstances(dataDir: string, self: string): Set<string> {
  const claimed = new Set<string>()
  for (const j of listJournals(dataDir)) {
    if (j.file === self) continue
    for (const e of Journal.read(j.file)) claimed.add(e.hwnd)
  }
  return claimed
}
