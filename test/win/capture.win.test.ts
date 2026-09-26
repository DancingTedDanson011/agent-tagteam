import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from '../../src/main/capture/journal'
import { adoptWindow, setOwner, snapshotOriginal } from '../../src/main/capture/live'
import { recoverOrphans, SessionManager } from '../../src/main/capture/sessions'
import * as w from '../../src/main/win32/api'
import * as win from '../../src/main/win32/windows'
import { closeSpawned, openConhost, openTerminal, sleep, windowState } from './helpers'

const journalFile = () => join(mkdtempSync(join(tmpdir(), 'clio-win-')), 'journal.json')
const manager = (j: Journal) => new SessionManager(j, { ownWindows: () => [], selfElevated: false })

afterEach(() => closeSpawned())

describe('capture and release with real windows', () => {
  it('conhost: strips the frame and restores the exact original state', async () => {
    const h = await openConhost('CAP-CONHOST')
    const before = windowState(h)
    const j = new Journal(journalFile())
    const m = manager(j)

    expect(await m.capture(h)).toEqual({ ok: true, id: h.toString() })
    expect(j.entries()).toHaveLength(1)
    const during = windowState(h)
    expect(during.style & win.WS_CAPTION).toBe(0)
    expect(during.exStyle & win.WS_EX_TOOLWINDOW).toBe(win.WS_EX_TOOLWINDOW)

    expect(await m.release(h.toString())).toBe('restored')
    await sleep(200)
    expect(windowState(h)).toEqual(before)
    expect(j.entries()).toEqual([])
  })

  it('windows terminal: same round trip, including a set owner', async () => {
    const h = await openTerminal('echo CAP-WT')
    const before = windowState(h)
    const j = new Journal(journalFile())
    const m = manager(j)
    const owner = await openConhost('CAP-OWNER')

    expect((await m.capture(h)).ok).toBe(true)
    await setOwner(h, owner)
    expect(windowState(h).owner).toBe(Number(owner))
    expect(await m.release(h.toString())).toBe('restored')
    await sleep(200)
    expect(windowState(h)).toEqual(before)
  })

  it('a maximized window is normalized on capture and maximized again on release', async () => {
    const h = await openConhost('CAP-MAX')
    w.ShowWindow(h, 3) // SW_MAXIMIZE
    await sleep(300)
    expect(windowState(h).zoomed).toBe(true)
    const original = snapshotOriginal(h)
    expect(original).not.toBeNull()

    const m = manager(new Journal(journalFile()))
    await m.capture(h)
    await sleep(200)
    expect(windowState(h).zoomed).toBe(false)

    await m.release(h.toString())
    await sleep(300)
    expect(windowState(h).zoomed).toBe(true)
  })

  it('a minimized window is shown normally on capture and minimized again on release', async () => {
    const h = await openConhost('CAP-MIN')
    w.ShowWindow(h, 6) // SW_MINIMIZE
    await sleep(300)
    expect(win.isMinimized(h)).toBe(true)
    const m = manager(new Journal(journalFile()))
    await m.capture(h)
    await sleep(200)
    expect(win.isMinimized(h)).toBe(false)
    await m.release(h.toString())
    await sleep(300)
    expect(win.isMinimized(h)).toBe(true)
  })

  it('refuses windows that are not consoles', async () => {
    const taskbar = win.listTopLevelWindows().find((h) => win.getClassName(h) === 'Shell_TrayWnd')
    expect(taskbar).toBeDefined()
    expect(await manager(new Journal(journalFile())).capture(taskbar!)).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('refuses the app’s own windows and double captures', async () => {
    const h = await openConhost('CAP-OWN')
    const own = new SessionManager(new Journal(journalFile()), { ownWindows: () => [h], selfElevated: false })
    expect(await own.capture(h)).toEqual({ ok: false, reason: 'unsupported' })
    const m = manager(new Journal(journalFile()))
    expect((await m.capture(h)).ok).toBe(true)
    expect(await m.capture(h)).toEqual({ ok: false, reason: 'already' })
    await m.releaseAll()
  })

  it('a window closed by the user leaves the session list and the journal', async () => {
    const h = await openConhost('CAP-CLOSE')
    const j = new Journal(journalFile())
    const m = manager(j)
    await m.capture(h)
    const removed: string[] = []
    m.on('removed', (id) => removed.push(id))
    w.PostMessageW(h, 0x0010, 0n, 0n)
    for (let i = 0; i < 20 && win.isWindow(h); i++) await sleep(100)
    m.refresh()
    expect(removed).toEqual([h.toString()])
    expect(m.list()).toEqual([])
    expect(j.entries()).toEqual([])
  })

  it('recoverOrphans restores windows a crashed run left behind', async () => {
    const h = await openConhost('CAP-ORPHAN')
    const before = windowState(h)
    const file = journalFile()
    await manager(new Journal(file)).capture(h) // the "crashed" run never releases
    expect(windowState(h).style & win.WS_CAPTION).toBe(0)

    const outcomes = await recoverOrphans(new Journal(file))
    await sleep(200)
    expect(outcomes).toEqual(['restored'])
    expect(windowState(h)).toEqual(before)
    expect(new Journal(file).entries()).toEqual([])
  })

  it('refuses an elevated console when the app itself is not elevated', async () => {
    const h = await openConhost('CAP-ELEV')
    const m = new SessionManager(new Journal(journalFile()), { ownWindows: () => [], selfElevated: false, isElevated: () => true })
    expect(await m.capture(h)).toEqual({ ok: false, reason: 'elevated' })
    const admin = new SessionManager(new Journal(journalFile()), { ownWindows: () => [], selfElevated: true, isElevated: () => true })
    expect((await admin.capture(h)).ok).toBe(true)
    await admin.releaseAll()
  })

  it('reports the real elevation of a normal console as not elevated', async () => {
    const h = await openConhost('CAP-ELEV-REAL')
    expect(win.isProcessElevated(win.getPid(h))).toBe(false)
  })

  it('adoptWindow keeps the window visible', async () => {
    const h = await openConhost('CAP-VIS')
    await adoptWindow(h, snapshotOriginal(h)!)
    expect(win.isVisible(h)).toBe(true)
  })
})
