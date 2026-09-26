// Drives the real app binary. APP_EXE selects it: the packaged exe, or (default) the dev Electron
// with this project. Checks what happens to captured windows AFTER the app is gone.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as w from '../../src/main/win32/api'
import * as win from '../../src/main/win32/windows'

const ROOT = resolve(__dirname, '../..')
const exe = process.env.APP_EXE ?? join(ROOT, 'node_modules/electron/dist/electron.exe')
// --lang=de: the selftest clicks German labels, whatever language this machine would pick
const baseArgs = [...(process.env.APP_EXE ? [] : [ROOT]), '--lang=de']
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Report = {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; detail: string }>
  windows: Array<{ hwnd: string; style: number; exStyle: number; rect: w.Rect | null }>
  appPid: number
}

let leftovers: bigint[] = []
afterEach(() => {
  for (const h of leftovers) if (win.isWindow(h)) w.PostMessageW(h, 0x0010, 0n, 0n)
  leftovers = []
})

async function waitFor<T>(fn: () => T | null | undefined, ms: number): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > until) throw new Error('timed out')
    await sleep(200)
  }
}

function readReport(file: string): Report | null {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Report
  } catch {
    return null
  }
}

function expectRestored(r: Report): void {
  for (const orig of r.windows) {
    const h = BigInt(orig.hwnd)
    leftovers.push(h)
    expect(win.isWindow(h), `window ${orig.hwnd} still exists`).toBe(true)
    expect(win.getStyle(h), `style of ${orig.hwnd}`).toBe(orig.style)
    expect(win.getExStyle(h), `ex-style of ${orig.hwnd}`).toBe(orig.exStyle)
    expect(Number(w.GetWindowLongPtrW(h, win.GWLP_HWNDPARENT)), `owner of ${orig.hwnd}`).toBe(0)
    expect(win.isVisible(h), `visible ${orig.hwnd}`).toBe(true)
    expect(win.getRect(h), `rect of ${orig.hwnd}`).toEqual(orig.rect)
  }
}

it('selftest passes and every window is back after a normal close', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'clio-e2e-')), 'report.json')
  const child = spawn(exe, [...baseArgs, `--selftest=${out}`], { stdio: 'ignore' })
  const code = await new Promise<number | null>((res) => child.on('exit', res))
  const report = readReport(out)
  expect(report, 'report written').not.toBeNull()
  const failed = report!.checks.filter((c) => !c.ok)
  expect(failed, JSON.stringify(failed, null, 1)).toEqual([])
  expect(code).toBe(0)
  await sleep(500)
  expectRestored(report!)
}, 180000)

it('a hard kill of the app: the watchdog restores every captured window', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'clio-e2e-')), 'report.json')
  const child = spawn(exe, [...baseArgs, `--selftest-hold=${out}`], { stdio: 'ignore' })
  const report = await waitFor(() => readReport(out), 90000)
  expect(report.checks.every((c) => c.ok), JSON.stringify(report.checks)).toBe(true)
  for (const orig of report.windows) {
    expect(win.getStyle(BigInt(orig.hwnd)) & win.WS_CAPTION, 'captured windows lost their frame').toBe(0)
  }

  execFileSync('taskkill', ['/F', '/PID', String(report.appPid)]) // no /T: a real crash does not kill the watchdog
  await new Promise((res) => child.on('exit', res))
  await waitFor(() => report.windows.every((o) => win.getStyle(BigInt(o.hwnd)) === o.style), 10000)
  await sleep(300)
  expectRestored(report)
}, 180000)

it('two instances: B takes a window over from A; a crash of either restores exactly what it holds', async () => {
  const outA = join(mkdtempSync(join(tmpdir(), 'clio-e2e-')), 'a.json')
  const childA = spawn(exe, [...baseArgs, `--selftest-hold=${outA}`], { stdio: 'ignore' })
  const a = await waitFor(() => readReport(outA), 90000)
  expect(a.checks.every((c) => c.ok), JSON.stringify(a.checks)).toBe(true)

  // B starts while A lives, and is pointed at one of A's windows
  const outB = join(mkdtempSync(join(tmpdir(), 'clio-e2e-')), 'b.json')
  const childB = spawn(exe, [...baseArgs, `--selftest-hold=${outB}`, `--selftest-foreign=${a.windows[0].hwnd}`], { stdio: 'ignore' })
  const b = await waitFor(() => readReport(outB), 90000)
  expect(b.checks.filter((c) => !c.ok), JSON.stringify(b.checks, null, 1)).toEqual([])
  expect(b.checks.map((c) => c.name)).toContain('foreign window is taken over')
  expect(b.appPid).not.toBe(a.appPid)
  const [moved, kept] = a.windows

  // A crashes: A's watchdog restores what A still holds; the window B took over and B's own stay captured
  execFileSync('taskkill', ['/F', '/PID', String(a.appPid)])
  await new Promise((res) => childA.on('exit', res))
  await waitFor(() => win.getStyle(BigInt(kept.hwnd)) === kept.style, 10000)
  await sleep(300)
  expectRestored({ ...a, windows: [kept] })
  for (const o of [moved, ...b.windows]) {
    expect(win.getStyle(BigInt(o.hwnd)) & win.WS_CAPTION, `B still holds ${o.hwnd}`).toBe(0)
  }

  // then B goes too: its watchdog brings back its own windows AND the taken-over one, to its real original
  execFileSync('taskkill', ['/F', '/PID', String(b.appPid)])
  await new Promise((res) => childB.on('exit', res))
  const all = [moved, ...b.windows]
  await waitFor(() => all.every((o) => win.getStyle(BigInt(o.hwnd)) === o.style), 10000)
  await sleep(300)
  expectRestored({ ...b, windows: all })
}, 300000)
