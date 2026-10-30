import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { capturedWindowProcesses, findTileForPid, readProjectBranch } from './mapping'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('exact process ancestry mapping', () => {
  it('includes the verified classic console parent, without guessing a terminal-window parent', () => {
    const build = capturedWindowProcesses
    const classic = build([{ id: '100', pid: 2, className: 'ConsoleWindowClass' }], () => 1)
    expect(findTileForPid(1, classic, () => null)).toBe('100')
    const terminal = build([{ id: '200', pid: 2, className: 'CASCADIA_HOSTING_WINDOW_CLASS' }], () => 1)
    expect(findTileForPid(1, terminal, () => null)).toBeNull()
    expect(build([{ id: '100', pid: 2, className: 'ConsoleWindowClass' }], () => 1, [1])).toEqual([{ id: '100', pid: 2 }])
  })
  it('uses the nearest unique ancestor and never guesses among shared host processes', () => {
    const parent = (pid: number) => new Map([[13, 12], [12, 10], [10, 5]]).get(pid) ?? null
    expect(findTileForPid(13, [{ id: 'a1', pid: 10 }, { id: 'a2', pid: 5 }], parent)).toBe('a1')
    expect(findTileForPid(13, [{ id: 'a1', pid: 10 }, { id: 'a2', pid: 10 }], parent)).toBeNull()
  })

  it('stops on cycles, inaccessible processes and invalid ids', () => {
    expect(findTileForPid(13, [{ id: 'a1', pid: 10 }], () => 13)).toBeNull()
    expect(findTileForPid(13, [{ id: 'a1', pid: 10 }], () => null)).toBeNull()
    expect(findTileForPid(0, [{ id: 'a1', pid: 0 }], () => null)).toBeNull()
  })
})

describe('project branch from real Git metadata', () => {
  it('reads regular and linked working trees without spawning a shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-cockpit-branch-')); directories.push(dir)
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/cockpit\n')
    expect(await readProjectBranch(dir)).toBe('feature/cockpit')
    const linked = join(dir, 'linked'); mkdirSync(linked)
    writeFileSync(join(linked, '.git'), 'gitdir: ../.git\n')
    expect(await readProjectBranch(linked)).toBe('feature/cockpit')
    writeFileSync(join(dir, '.git', 'HEAD'), 'a'.repeat(40))
    expect(await readProjectBranch(linked)).toBeNull()
  })
})
