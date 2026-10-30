import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** A separate SQLite file supplies an OS lock, automatically released on process death. */
export function acquireWriterLock(path: string): { close(): void } | null {
  mkdirSync(dirname(path), { recursive: true })
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
  } catch (error) {
    database.close()
    const code = (error as { errcode?: number }).errcode
    if (code === 5 || code === 6) return null
    throw error
  }
  let closed = false
  return {
    close() {
      if (closed) return
      closed = true
      try {
        database.exec('ROLLBACK')
      } finally {
        database.close()
      }
    }
  }
}
