import { open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export type TileProcess = { id: string; pid: number }

/** Classic console ownership can belong to a child of the shell. Terminal hosts are shared. */
export function capturedWindowProcesses(windows: Array<TileProcess & { className: string }>, parent: (pid: number) => number | null, excluded: number[] = []): TileProcess[] {
  return windows.flatMap(window => {
    if (!Number.isSafeInteger(window.pid) || window.pid <= 0) return []
    const result = [{ id: window.id, pid: window.pid }]
    if (window.className === 'ConsoleWindowClass') {
      const shell = parent(window.pid)
      if (shell && shell !== window.pid && Number.isSafeInteger(shell) && shell > 0 && !excluded.includes(shell)) result.push({ id: window.id, pid: shell })
    }
    return result
  })
}

/** An ambiguous host process is not enough to select a window. Prefer no mapping to a wrong one. */
export function findTileForPid(pid: number, tiles: TileProcess[], parent: (pid: number) => number | null): string | null {
  const visited = new Set<number>()
  let current: number | null = pid
  while (current !== null && Number.isSafeInteger(current) && current > 0 && visited.size < 64 && !visited.has(current)) {
    visited.add(current)
    const matches = tiles.filter(tile => tile.pid === current)
    if (matches.length > 1) return null
    if (matches.length === 1) return matches[0].id
    current = parent(current)
  }
  return null
}

async function smallText(file: string): Promise<string | null> {
  try {
    const fd = await open(file, 'r')
    try {
      if (!(await fd.stat()).isFile()) return null
      const buffer = Buffer.alloc(8193)
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0)
      return bytesRead <= 8192 ? buffer.subarray(0, bytesRead).toString('utf8').trim() : null
    } finally { await fd.close() }
  } catch { return null }
}

export async function readProjectBranch(root: string): Promise<string | null> {
  try {
    let git = join(root, '.git')
    if ((await stat(git)).isFile()) {
      const pointer = await smallText(git)
      if (!pointer?.startsWith('gitdir: ') || pointer.includes('\0')) return null
      git = resolve(root, pointer.slice(8))
    }
    const head = await smallText(join(git, 'HEAD'))
    return head?.startsWith('ref: refs/heads/') ? head.slice(16) : null
  } catch { return null }
}

/** Group subdirectories by the nearest real Git project, preserving non-Git folders as projects. */
export async function canonicalProjectRoot(cwd: string): Promise<string | null> {
  if (!isAbsolute(cwd) || cwd.includes('\0')) return null
  try {
    const original = await realpath(cwd)
    if (!(await stat(original)).isDirectory()) return null
    let current = original
    for (let depth = 0; depth < 64; depth++) {
      try {
        const metadata = await stat(join(current, '.git'))
        if (metadata.isDirectory() || metadata.isFile()) return current
      } catch { /* A normal folder has no Git metadata. */ }
      const next = dirname(current)
      if (next === current) break
      current = next
    }
    return original
  } catch { return null }
}
