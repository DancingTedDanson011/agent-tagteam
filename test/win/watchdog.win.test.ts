// The PowerShell watchdog must leave captured windows alone while its parent lives, and restore
// them exactly once the parent is gone.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Journal } from '../../src/main/capture/journal'
import { SessionManager } from '../../src/main/capture/sessions'
import * as win from '../../src/main/win32/windows'
import { closeSpawned, openConhost, sleep, windowState } from './helpers'

const SCRIPT = resolve(__dirname, '../../resources/watchdog.ps1')
let parent: ChildProcess | null = null

afterEach(() => {
  parent?.kill()
  parent = null
  closeSpawned()
})

function startWatchdog(parentPid: number, parentStart: string | null, journal: string, log: string) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT]
  args.push('-ParentPid', String(parentPid), '-Journal', journal, '-Log', log)
  if (parentStart) args.push('-ParentStart', parentStart)
  return spawn('powershell.exe', args, { stdio: 'ignore', windowsHide: true })
}

async function captured(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), 'clio-wd-'))
  const journalFile = join(dir, 'journal.json')
  const h = await openConhost(tag)
  const before = windowState(h)
  const m = new SessionManager(new Journal(journalFile), { ownWindows: () => [], selfElevated: false })
  expect((await m.capture(h)).ok).toBe(true)
  return { h, before, journalFile, log: join(dir, 'watchdog.log') }
}

it('does nothing while the parent lives, restores after it dies', async () => {
  const { h, before, journalFile, log } = await captured('WD-LIFE')
  parent = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
  const wd = startWatchdog(parent.pid!, win.processStartTime(parent.pid!), journalFile, log)

  await sleep(4000) // PowerShell + Add-Type startup
  expect(win.getStyle(h) & win.WS_CAPTION, 'still captured while the parent lives').toBe(0)
  expect(new Journal(journalFile).entries()).toHaveLength(1)

  parent.kill()
  await new Promise((r) => wd.on('exit', r))
  expect(windowState(h)).toEqual(before)
  expect(new Journal(journalFile).entries(), 'journal emptied (and readable despite PowerShell)').toEqual([])
  expect(readFileSync(log, 'utf8')).toMatch(/captured window\(s\): restored/)
}, 60000)

it('a reused PID (start time differs) counts as a dead parent: restores at once', async () => {
  const { h, before, journalFile, log } = await captured('WD-REUSE')
  parent = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
  const wd = startWatchdog(parent.pid!, '1', journalFile, log)
  await new Promise((r) => wd.on('exit', r))
  expect(windowState(h)).toEqual(before)
})

it('an empty journal is a clean exit and leaves the file untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clio-wd-'))
  const journalFile = join(dir, 'journal.json')
  new Journal(journalFile).add({
    hwnd: '1',
    pid: 1,
    startTime: null,
    className: 'x',
    style: 0,
    exStyle: 0,
    placement: { length: 44, flags: 0, showCmd: 1, ptMinPosition: { x: 0, y: 0 }, ptMaxPosition: { x: 0, y: 0 }, rcNormalPosition: { left: 0, top: 0, right: 1, bottom: 1 } }
  })
  new Journal(journalFile).remove('1')
  const wd = startWatchdog(999999, '1', journalFile, join(dir, 'watchdog.log'))
  await new Promise((r) => wd.on('exit', r))
  expect(readFileSync(join(dir, 'watchdog.log'), 'utf8')).toMatch(/ended cleanly/)
  expect(existsSync(journalFile + '.tmp')).toBe(false)
})

it('a journal the app deleted on a clean exit is a clean exit, not an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clio-wd-'))
  const wd = startWatchdog(999999, '1', join(dir, 'journal.json'), join(dir, 'watchdog.log'))
  const code = await new Promise((r) => wd.on('exit', r))
  expect(readFileSync(join(dir, 'watchdog.log'), 'utf8')).toMatch(/ended cleanly/)
  expect(code).toBe(0)
})

it('launchIndependent starts the watchdog so that it really runs the script', async () => {
  const { launchIndependent, systemDirectory } = await import('../../src/main/win32/launch')
  expect(() => launchIndependent('powershell.exe', []), 'a bare name would be searched in the app directory').toThrow()
  const powershell = join(systemDirectory(), 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const dir = mkdtempSync(join(tmpdir(), 'clio-wd-'))
  const journalFile = join(dir, 'journal.json')
  new Journal(journalFile).add({
    hwnd: '1', pid: 1, startTime: null, className: 'x', style: 0, exStyle: 0,
    placement: { length: 44, flags: 0, showCmd: 1, ptMinPosition: { x: 0, y: 0 }, ptMaxPosition: { x: 0, y: 0 }, rcNormalPosition: { left: 0, top: 0, right: 1, bottom: 1 } }
  })
  const log = join(dir, 'watchdog log with spaces.txt')
  const pid = launchIndependent(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ParentPid', '999999', '-ParentStart', '1', '-Journal', journalFile, '-Log', log])
  expect(pid).toBeGreaterThan(0)
  for (let i = 0; i < 60 && !existsSync(log); i++) await sleep(250)
  expect(readFileSync(log, 'utf8')).toMatch(/captured window\(s\): gone/)
}, 30000)
