// A foreign window whose UI thread is stuck must not freeze the app's main thread.
import { spawn } from 'node:child_process'
import { afterAll, expect, it } from 'vitest'
import * as w from '../../src/main/win32/api'
import * as ax from '../../src/main/win32/async'
import * as win from '../../src/main/win32/windows'
import { sleep } from './helpers'

const HANG_MS = 6000
let hwnd: bigint | undefined

afterAll(() => {
  if (hwnd && win.isWindow(hwnd)) w.PostMessageW(hwnd, 0x0010, 0n, 0n)
})

async function openHungWindow(): Promise<bigint> {
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = 'CLIO-HUNG-PROBE'; " +
    `$f.Show(); [System.Threading.Thread]::Sleep(${HANG_MS})`
  spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' }).unref()
  for (let i = 0; i < 100; i++) {
    const h = win.listTopLevelWindows().find((x) => win.getTitle(x) === 'CLIO-HUNG-PROBE')
    if (h) return h
    await sleep(100)
  }
  throw new Error('probe window did not appear')
}

it('style writes to a hung window run off the main thread', async () => {
  hwnd = await openHungWindow()
  for (let i = 0; i < 60 && !ax.isHung(hwnd); i++) await sleep(100)
  expect(ax.isHung(hwnd)).toBe(true)

  const started = performance.now()
  let settled = false
  const write = ax.setWindowLong(hwnd, win.GWL_STYLE, win.getStyle(hwnd)).then(() => (settled = true))

  // The event loop keeps ticking while the worker waits for the hung window.
  const before = performance.now()
  await sleep(50)
  const loopDelay = performance.now() - before
  expect(loopDelay).toBeLessThan(500)
  expect(settled).toBe(false)

  await write
  expect(performance.now() - started).toBeGreaterThan(500) // the call really was blocked in the worker
}, 30000)
