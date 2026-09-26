// Workspace restore with real windows. Only windows started here are touched, and closed at the end.
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startWindow, waitForNewWindow, windowClassOf } from '../../src/main/restore/relaunch'
import * as w from '../../src/main/win32/api'
import { processCwd } from '../../src/main/win32/process-cwd'
import * as win from '../../src/main/win32/windows'
import { closeSpawned, openConhost, sleep } from './helpers'

const ours: bigint[] = []
afterEach(() => {
  closeSpawned()
  for (const h of ours.splice(0)) if (win.isWindow(h)) w.PostMessageW(h, 0x0010, 0n, 0n) // WM_CLOSE
})

const tempDir = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'clio-restore-')))

describe('reading the folder of a console window', () => {
  it('cmd: the folder after cd', async () => {
    const dir = tempDir()
    const sub = join(dir, 'sub')
    mkdirSync(sub)
    const h = await openConhost('CWD-CMD', `cd /d ${sub}`)
    await sleep(700)
    expect(processCwd(win.getPid(h))).toBe(sub + '\\')
  })

  it('a process that does not exist reads as null, not a guess', () => {
    expect(processCwd(0)).toBeNull()
  })
})

describe('starting a window again', () => {
  it('a classic PowerShell window in the folder', async () => {
    const dir = tempDir()
    const launch = { kind: 'window' as const, host: 'conhost' as const, shell: 'powershell' as const, cwd: dir }
    const before = new Set(win.listTopLevelWindows())
    const isOurs = startWindow(launch, dir, {}, false)
    expect(isOurs).not.toBeNull()
    const h = await waitForNewWindow(before, windowClassOf(launch), isOurs!, 10000)
    expect(h).not.toBeNull()
    ours.push(h!)
    await sleep(1200)
    expect(processCwd(win.getPid(h!))).toBe(dir + '\\')
  })

  it('another console window opening at the same moment is not taken for the restored one (cold review)', async () => {
    const dir = tempDir()
    const launch = { kind: 'window' as const, host: 'conhost' as const, shell: 'cmd' as const, cwd: dir }
    const before = new Set(win.listTopLevelWindows())
    const other = await openConhost('CLIO-NOT-OURS') // appears first, like a window the user opens meanwhile
    const isOurs = startWindow(launch, dir, {}, false)
    expect(isOurs).not.toBeNull()
    expect(isOurs!(other)).toBe(false)
    const h = await waitForNewWindow(before, windowClassOf(launch), isOurs!, 10000)
    expect(h).not.toBeNull()
    ours.push(h!)
    expect(h).not.toBe(other)
    await sleep(800)
    expect(processCwd(win.getPid(h!))).toBe(dir + '\\')
  })

  it('Windows Terminal: a new window of its own, with the saved name as title', async () => {
    const dir = tempDir()
    const launch = { kind: 'window' as const, host: 'wt' as const, cwd: dir }
    const before = new Set(win.listTopLevelWindows())
    const isOurs = startWindow(launch, dir, { label: 'CLIO-RESTORE-WT', color: 'green' }, false)
    expect(isOurs).not.toBeNull()
    const h = await waitForNewWindow(before, windowClassOf(launch), isOurs!, 15000)
    expect(h).not.toBeNull()
    ours.push(h!)
    let title = ''
    for (let i = 0; i < 20 && title !== 'CLIO-RESTORE-WT'; i++) {
      await sleep(200)
      title = win.getTitle(h!)
    }
    expect(title).toBe('CLIO-RESTORE-WT')
  })
})
