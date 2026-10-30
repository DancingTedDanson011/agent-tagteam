import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { parse, sep } from 'node:path'

/** Compare existing directories by filesystem identity, without Unicode case folding. */
export function sameDirectory(left: string, right: string): boolean {
  try {
    const a = realpathSync.native(left), b = realpathSync.native(right)
    const aStat = statSync(a, { bigint: true }), bStat = statSync(b, { bigint: true })
    return aStat.isDirectory() && bStat.isDirectory() && (a === b ||
      (parse(a).root === parse(b).root && aStat.ino !== 0n && aStat.dev === bStat.dev && aStat.ino === bStat.ino))
  } catch { return false }
}

/** Arguments are normalized absolute paths; resolve links before checking containment. */
export function isWithinDirectory(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Flush the replacement before rename. Each writer owns its temporary file. */
export function atomicWrite(file: string, data: string | Uint8Array): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let created = false
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    created = true
    try {
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, file)
  } finally {
    if (created) rmSync(temporary, { force: true })
  }
}
