// Restore journal: the original state of every captured window, written to disk BEFORE the
// window is modified. The watchdog and the next app start read it after a crash.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseJournalEntry } from '../../shared/validate'
import type { WindowPlacement } from '../win32/api'
import { atomicWrite } from '../fsutil'

export type JournalEntry = {
  hwnd: string
  pid: number
  /** Process creation time; guards against a reused PID. Null if it could not be read. */
  startTime: string | null
  className: string
  style: number
  exStyle: number
  placement: WindowPlacement
}

type JournalFile = { version: 1; entries: JournalEntry[] }

const BOM = 0xfeff

export class Journal {
  private list: JournalEntry[]

  constructor(private readonly file: string) {
    this.list = Journal.read(file)
  }

  static read(file: string): JournalEntry[] {
    try {
      // The watchdog (PowerShell) may have written it; tolerate a UTF-8 byte order mark.
      const raw = readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw.charCodeAt(0) === BOM ? raw.slice(1) : raw) as Partial<JournalFile>
      if (!Array.isArray(parsed.entries)) return []
      // Validated: a second program (the watchdog) writes this file, and a bad entry must not stop the app.
      return parsed.entries.map(parseJournalEntry).filter((e): e is JournalEntry => e !== null)
    } catch {
      return [] // missing or corrupt: nothing we can restore from it
    }
  }

  entries(): JournalEntry[] {
    return [...this.list]
  }

  add(entry: JournalEntry): void {
    this.list = [...this.list.filter((e) => e.hwnd !== entry.hwnd), entry]
    this.flush()
  }

  remove(hwnd: string): void {
    this.list = this.list.filter((e) => e.hwnd !== hwnd)
    this.flush()
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const data: JournalFile = { version: 1, entries: this.list }
    atomicWrite(this.file, JSON.stringify(data, null, 1))
  }
}
