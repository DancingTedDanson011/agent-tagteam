// snapshotWindow must read the content of a console window even while it sits behind other windows,
// and the block diff must see new output but not an idle prompt.
import { afterEach, expect, it } from 'vitest'
import { blockHashes, countChanged } from '../../src/main/activity/frames'
import * as w from '../../src/main/win32/api'
import * as win from '../../src/main/win32/windows'
import { snapshotWindow } from '../../src/main/win32/snapshot'
import { closeSpawned, openConhost, sleep } from './helpers'

afterEach(() => closeSpawned())

const hashesOf = async (h: bigint) => {
  const s = await snapshotWindow(h)
  expect(s).not.toBeNull()
  return blockHashes(s!.bgra, s!.width, s!.height)
}

it('captures the full window size with real content', async () => {
  const h = await openConhost('SNAP-SIZE')
  const r = win.getRect(h)!
  const s = await snapshotWindow(h)
  expect(s).not.toBeNull()
  expect(s!.width).toBe(r.right - r.left)
  expect(s!.height).toBe(r.bottom - r.top)
  let colored = 0
  for (let i = 0; i < s!.bgra.length; i += 4) if (s!.bgra[i] | s!.bgra[i + 1] | s!.bgra[i + 2]) colored++
  expect(colored).toBeGreaterThan(0)
})

it('sees output of an occluded window and stays quiet when it is idle', async () => {
  const h = await openConhost('SNAP-DIFF', 'ping -n 6 127.0.0.1')
  w.SetWindowPos(h, win.HWND_BOTTOM, 50, 50, 700, 400, win.SWP_NOACTIVATE)
  await sleep(500)
  const a = await hashesOf(h)
  await sleep(1200)
  const b = await hashesOf(h)
  expect(countChanged(a, b)).toBeGreaterThan(2) // new ping lines

  for (let i = 0; i < 80 && win.getTitle(h).includes('ping'); i++) await sleep(100) // ping still running
  await sleep(1500)
  const c = await hashesOf(h)
  await sleep(1200)
  const d = await hashesOf(h)
  expect(countChanged(c, d)).toBeLessThanOrEqual(2) // idle prompt: at most the cursor cell
})
