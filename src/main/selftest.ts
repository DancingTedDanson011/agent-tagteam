// End-to-end self test inside the real app: real test windows, real clicks in the page, real
// window positions. Started with --selftest=<report.json> (or --selftest-hold=<report.json> for the
// crash test, which captures and then waits to be killed). Only touches windows it spawned itself.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { app, clipboard, screen } from 'electron'
import { offsetRect, type Box } from '../shared/geometry'
import type { ActivityMonitor } from './activity/monitor'
import { findOnPath } from './agents/programs'
import type { AgentWiring } from './agents/wire'
import type { Journal } from './capture/journal'
import type { SessionManager } from './capture/sessions'
import type { Placer } from './placement/placer'
import type { Thumbnails } from './placement/thumbs'
import * as w from './win32/api'
import * as ax from './win32/async'
import type { HWND } from './win32/api'
import { processCwd } from './win32/process-cwd'
import * as win from './win32/windows'
import { cockpitChecks } from './cockpit/selftest'

export type SelftestContext = {
  window: BrowserWindow
  sessions: SessionManager
  placer: Placer
  thumbs: Thumbnails
  agents: AgentWiring
  monitor: ActivityMonitor
  journal: Journal
  journalPath: string
  workspacesPath: string
  settingsPath: string
}

type Check = { name: string; ok: boolean; detail: string }
export type SelftestReport = {
  ok: boolean
  checks: Check[]
  windows: Array<{ hwnd: string; style: number; exStyle: number; rect: w.Rect | null }>
  appPid: number
  diagnostics: Record<string, unknown>
}

const GW_HWNDNEXT = 2
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function spawnWindow(kind: 'conhost' | 'wt', command: string, dir?: string): Promise<HWND> {
  const before = new Set(win.listTopLevelWindows())
  if (kind === 'conhost') {
    const inDir = dir ? ['/D', dir] : []
    spawn('cmd.exe', ['/c', 'start', '"clio-selftest"', ...inDir, 'conhost.exe', 'cmd.exe', '/k', command], { stdio: 'ignore' }).unref()
  } else {
    spawn('wt.exe', ['-w', 'new', 'cmd.exe', '/k', command], { stdio: 'ignore' }).unref()
  }
  const cls = kind === 'conhost' ? 'ConsoleWindowClass' : 'CASCADIA_HOSTING_WINDOW_CLASS'
  for (let i = 0; i < 75; i++) {
    const h = win.listConsoleWindows().find((x) => !before.has(x) && win.getClassName(x) === cls)
    if (h) {
      await sleep(400)
      return h
    }
    await sleep(200)
  }
  throw new Error(`selftest: no ${kind} window appeared`)
}

export async function runSelftest(ctx: SelftestContext, hold = false, foreign: string | null = null): Promise<SelftestReport> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })
  const js = <T>(code: string): Promise<T> => ctx.window.webContents.executeJavaScript(code, true)
  const app = ctx.placer.appHwnd()
  const content = () => ctx.window.getContentBounds()
  const toScreen = (r: Box) => screen.dipToScreenRect(ctx.window, offsetRect(content(), r))
  const rectOf = (h: HWND) => win.getRect(h)
  const near = (a: number, b: number) => Math.abs(a - b) <= 2
  const matches = (h: HWND, expected: Box) => {
    const r = rectOf(h)
    return !!r && near(r.left, expected.x) && near(r.top, expected.y) && near(r.right - r.left, expected.width) && near(r.bottom - r.top, expected.height)
  }
  const bodyRect = (id: string) =>
    js<Box | null>(`(() => {
      const el = [...document.querySelectorAll('.tile')].find(t => t.querySelector('.tile-body') && t.dataset.id === ${JSON.stringify(id)})
        ?? null
      const body = el?.querySelector('.tile-body')
      if (!body) return null
      const r = body.getBoundingClientRect()
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
    })()`)
  const ownerOf = (h: HWND) => Number(w.GetWindowLongPtrW(h, win.GWLP_HWNDPARENT))
  const isAbove = (h: HWND, other: HWND) => {
    for (let cur = w.GetWindow(h, GW_HWNDNEXT) as HWND | null, i = 0; cur && i < 5000; cur = w.GetWindow(cur, GW_HWNDNEXT) as HWND | null, i++) {
      if (cur === other) return true
    }
    return false
  }
  const clickText = (selector: string, text: string) =>
    js<boolean>(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)}))
      if (!el) return false
      el.click()
      return true
    })()`)

  if (!hold) await cockpitChecks(ctx, check)
  const conhost = await spawnWindow('conhost', 'echo CLIO-SELFTEST-A')
  const terminal = await spawnWindow('wt', 'echo CLIO-SELFTEST-B')
  const originals = [conhost, terminal].map((h) => ({
    hwnd: h.toString(),
    style: win.getStyle(h),
    exStyle: win.getExStyle(h),
    rect: rectOf(h)
  }))
  const diagnostics: Record<string, unknown> = {}
  const measure = (label: string) =>
    js<Record<string, unknown>>(`(() => {
      const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
      return { viewport: [innerWidth, innerHeight], app: box('.app'), stage: box('.stage'), view: box('.focus-view, .grid-view, .tabs-view, .free-view'), tile: box('.tile'), body: box('.tile-body'), panel: box('.tab-panel') }
    })()`).then((m) => {
      diagnostics[label] = { ...m, bounds: ctx.window.getBounds(), content: ctx.window.getContentBounds(), display: screen.getDisplayMatching(ctx.window.getBounds()).workArea }
    })
  const report = (): SelftestReport => ({ ok: checks.every((c) => c.ok), checks, windows: originals, appPid: process.pid, diagnostics })

  // 1. capture both through the same path a drop uses
  const a = await ctx.sessions.capture(conhost)
  const b = await ctx.sessions.capture(terminal)
  check('capture conhost', a.ok, JSON.stringify(a))
  check('capture windows terminal', b.ok, JSON.stringify(b))
  check('journal has both before anything else', ctx.journal.entries().length === 2, `${ctx.journal.entries().length}`)
  if (!a.ok || !b.ok) return report()
  ctx.window.webContents.send('captured', b.id)
  await sleep(1200)

  if (hold) {
    if (foreign) {
      // Another running instance holds this window: this start must not have restored it, the
      // picker must not offer it, and a capture must be refused without touching it.
      const h = BigInt(foreign)
      check('foreign window is still captured by its own instance', win.isWindow(h) && (win.getStyle(h) & win.WS_CAPTION) === 0, win.getStyle(h).toString(16))
      const refused = await ctx.sessions.capture(h)
      check('foreign window cannot be captured directly', !refused.ok && refused.reason === 'other-instance', JSON.stringify(refused))
      const offered = await js<Array<{ hwnd: string; heldBy?: string }>>(`window.organizer.listCandidates()`)
      check('foreign window is offered, marked as held by another organizer', offered.some((c) => c.hwnd === foreign && c.heldBy === 'instance'), JSON.stringify(offered))
      // Take it over the way the picker does: the other instance releases it, this one captures it.
      const took = await js<{ ok: boolean }>(`window.organizer.capture(${JSON.stringify(foreign)})`)
      check('foreign window is taken over', took.ok, JSON.stringify(took))
      const entry = ctx.journal.entries().find((e) => e.hwnd === foreign)
      check('taken-over window is journaled here with its real original (frame)', !!entry && (entry.style & win.WS_CAPTION) !== 0, JSON.stringify(entry))
    }
    check('hold: captured and waiting to be killed', true)
    return report()
  }

  await measure('focus')
  // 1b. language: EN switches every label, DE switches back; a test run never writes the user's settings
  const settingsFile = ctx.settingsPath
  const settingsBefore = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null
  const labels = () =>
    js<{ lang: string; capture: string; focus: string }>(`({
      lang: document.documentElement.lang,
      capture: document.querySelector('.titlebar-actions .button.is-primary')?.textContent ?? '',
      focus: document.querySelector('.view-button')?.textContent ?? ''
    })`)
  const de = await labels()
  check('starts in German (--lang=de)', de.lang === 'de' && de.capture === 'Terminal einfangen' && de.focus === 'Fokus', JSON.stringify(de))
  await clickText('.lang-button', 'EN')
  await sleep(300)
  const en = await labels()
  check('EN switches the labels', en.lang === 'en' && en.capture === 'Capture terminal' && en.focus === 'Focus', JSON.stringify(en))
  await clickText('.lang-button', 'DE')
  await sleep(300)
  check('DE switches back', (await labels()).capture === 'Terminal einfangen')
  const settingsAfter = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null
  check("a test run leaves the user's language setting alone", settingsAfter === settingsBefore)

  // 2. focus view: the big session is live over its slot, the other is a thumbnail parked below the app
  const tiles = await js<number>(`document.querySelectorAll('.tile .tile-body').length`)
  const cards = await js<number>(`document.querySelectorAll('.side-card').length`)
  const openCard = await js<string | null>(`document.querySelector('.side-card.is-open')?.dataset.id ?? null`)
  check('focus view: one big tile; the list keeps it, highlighted as open', tiles === 1 && cards === 2 && openCard === b.id, `tiles=${tiles} cards=${cards} open=${openCard}`)
  check('the open session is mirrored as a live preview in the list', ctx.thumbs.has(`${b.id}#mirror`))
  const bigRect = await bodyRect(b.id)
  check('big slot measured', !!bigRect, JSON.stringify(bigRect))
  if (bigRect) check('live window sits exactly over its slot', matches(terminal, toScreen(bigRect)), `${JSON.stringify(rectOf(terminal))} vs ${JSON.stringify(toScreen(bigRect))}`)
  check('live window is owned by the app', ownerOf(terminal) === Number(app), `${ownerOf(terminal)}`)
  check('live window is above the app', isAbove(terminal, app))
  check('thumbnail window is not owned', ownerOf(conhost) === 0, `${ownerOf(conhost)}`)
  check('thumbnail window is parked below the app', isAbove(app, conhost))

  // 3. click the side card: the small one becomes big
  const clicked = await js<boolean>(`(() => { const c = document.querySelector('.side-card:not(.is-open)'); c?.click(); return !!c })()`)
  await sleep(900)
  const swapRect = await bodyRect(a.id)
  check('side card click swaps the big session', clicked && !!swapRect, `clicked=${clicked}`)
  if (swapRect) check('swapped window sits over the big slot', matches(conhost, toScreen(swapRect)), `${JSON.stringify(rectOf(conhost))} vs ${JSON.stringify(toScreen(swapRect))}`)
  check('previous big one is parked now', ownerOf(terminal) === 0 && isAbove(app, terminal))

  // 4. grid view: both live, each over its own tile
  check('switch to grid view', await clickText('.view-button', 'Raster'))
  await sleep(900)
  await measure('grid')
  for (const [id, h] of [[a.id, conhost], [b.id, terminal]] as const) {
    const r = await bodyRect(id)
    check(`grid: ${id} over its tile`, !!r && matches(h, toScreen(r)), `${JSON.stringify(rectOf(h))} vs ${r ? JSON.stringify(toScreen(r)) : 'no slot'}`)
  }

  // 5. tabs view: exactly one live
  check('switch to tabs view', await clickText('.view-button', 'Tabs'))
  await sleep(900)
  await measure('tabs')
  const owned = [conhost, terminal].filter((h) => ownerOf(h) === Number(app)).length
  check('tabs: exactly one window live', owned === 1, `owned=${owned}`)

  // 6. minimize the app: captured windows hide; restore: they come back
  ctx.window.minimize()
  await sleep(900)
  check('app minimized hides captured windows', !win.isVisible(conhost) && !win.isVisible(terminal))
  ctx.window.restore()
  await sleep(1200)
  check('app restored shows captured windows', win.isVisible(conhost) && win.isVisible(terminal))

  // 7. dock: minimize a session from its header, restore it from the dock
  check('back to focus view', await clickText('.view-button', 'Fokus'))
  await sleep(700)
  const docked = await js<boolean>(`(() => { const b = document.querySelector('.tile .session-actions button'); b?.click(); return !!b })()`)
  await sleep(700)
  const dockItems = await js<number>(`document.querySelectorAll('.dock-item').length`)
  check('header minimize puts the session into the dock', docked && dockItems === 1, `dock=${dockItems}`)
  await js(`document.querySelector('.dock-item')?.click()`)
  await sleep(700)
  check('dock click brings it back', (await js<number>(`document.querySelectorAll('.dock-item').length`)) === 0)

  // 8. the badge: a small session that works and then goes quiet gets "waits for you";
  //    clicking it makes it big and clears the badge
  const worker = await spawnWindow('conhost', 'ping -n 12 127.0.0.1')
  originals.push({ hwnd: worker.toString(), style: win.getStyle(worker), exStyle: win.getExStyle(worker), rect: rectOf(worker) })
  const c = await ctx.sessions.capture(worker)
  check('capture a working session', c.ok, JSON.stringify(c))
  if (c.ok) {
    // Put a different session in focus so the worker is a small, unattended side card.
    const cid = JSON.stringify(c.id)
    await js(`[...document.querySelectorAll('.side-card:not(.is-open)')].find(e => e.dataset.id !== ${cid})?.click()`)
    let badged = false
    for (let i = 0; i < 30 && !badged; i++) {
      await sleep(1000)
      badged = ctx.monitor.info(c.id).badge
    }
    check('badge appears after the work phase ends', badged, JSON.stringify(ctx.monitor.info(c.id)))
    await sleep(600)
    const shown = await js<boolean>(`!!document.querySelector('.side-card.has-badge[data-id=' + JSON.stringify(${cid}) + ']')`)
    check('badge is visible on the small session', shown)
    await js(`document.querySelector('.side-card[data-id=' + JSON.stringify(${cid}) + ']')?.click()`)
    await sleep(900)
    const bigId = await js<string | null>(`document.querySelector('.focus-main .tile')?.dataset.id ?? null`)
    const frames = await js<{ visibility: string; frames: number; focused: boolean }>(`new Promise((res) => {
      let n = 0
      const f = () => { n++; requestAnimationFrame(f) }
      requestAnimationFrame(f)
      setTimeout(() => res({ visibility: document.visibilityState, frames: n, focused: document.hasFocus() }), 500)
    })`)
    // Chromium's occlusion tracking marked this page hidden here (captured windows above and below the
    // app), stopping animation frames and with them the layout sync — measured: hidden, 0 frames.
    check('the page keeps rendering while captured windows surround it', frames.visibility === 'visible' && frames.frames > 0, JSON.stringify(frames))
    diagnostics['badge-click'] = { frames, foreground: String(w.GetForegroundWindow()), app: String(app), worker: String(worker), minimized: ctx.window.isMinimized(), visible: ctx.window.isVisible() }
    const placed = ctx.placer.current().placements.find((p) => p.id === c.id)
    check('click on the badged session makes it big and clears the badge', ownerOf(worker) === Number(app) && !ctx.monitor.info(c.id).badge, JSON.stringify({ ...ctx.monitor.info(c.id), bigId, worker: c.id, placed, owner: ownerOf(worker), sessions: ctx.sessions.list().map((x) => x.id) }))
  }

  if (c.ok) {
    // 9. dragged out of the organizer: the header offers "Zurückholen", a click on the view puts it back
    const waitFor = async (cond: () => Promise<boolean>, ms = 4000) => {
      for (let t = 0; t < ms; t += 250) {
        if (await cond()) return true
        await sleep(250)
      }
      return cond()
    }
    const bringBack = () => js<boolean>(`[...document.querySelectorAll('.tile .session-actions button')].some(b => b.textContent.includes('Zurückholen'))`)
    const home = await bodyRect(c.id)
    const r0 = rectOf(worker)
    if (home && r0) {
      const slot = toScreen(home)
      w.SetWindowPos(worker, 0n, r0.left + 160, r0.top + 120, r0.right - r0.left - 200, r0.bottom - r0.top - 100, win.SWP_NOZORDER | win.SWP_NOACTIVATE)
      check('moved-out window is reported as displaced', await waitFor(bringBack), JSON.stringify(rectOf(worker)))
      check('click on the active view (Fokus)', await clickText('.view-button', 'Fokus'))
      await sleep(900)
      check('Fokus puts the moved-out window back over its slot, owned', matches(worker, slot) && ownerOf(worker) === Number(app), `${JSON.stringify(rectOf(worker))} vs ${JSON.stringify(slot)}`)
      check('the displaced notice goes away', await waitFor(async () => !(await bringBack())))

      w.ShowWindow(worker, 3) // SW_MAXIMIZE, what the terminal's own maximize button does
      check('maximized window is reported as displaced', await waitFor(bringBack), `zoomed=${w.IsZoomed(worker)}`)
      check('header button "Zurückholen" clicked', await clickText('.tile .session-actions button', 'Zurückholen'))
      await sleep(900)
      check('Zurückholen un-maximizes it and puts it back over its slot', w.IsZoomed(worker) === 0 && matches(worker, slot) && ownerOf(worker) === Number(app), `${JSON.stringify(rectOf(worker))} vs ${JSON.stringify(slot)}`)
    } else check('big slot of the worker measured', false, JSON.stringify({ home, r0 }))

    // 10. side list order: Alt+Down on the first card moves it down; the live previews follow
    ctx.window.focus()
    const sideOrder = () => js<string[]>(`[...document.querySelectorAll('.side-card')].map(e => e.dataset.id)`)
    const before = await sideOrder()
    await js(`document.querySelector('.side-card')?.focus()`)
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down', modifiers: ['alt'] })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down', modifiers: ['alt'] })
    await sleep(900)
    const after = await sideOrder()
    check('Alt+Down moves the first side card one down', before.length >= 2 && after[0] === before[1] && after[1] === before[0], `${before} -> ${after}`)
    // The open (big) session's card shows a mirror of it: its preview is drawn under "<id>#mirror".
    const thumbKey = (id: string) => (ctx.thumbs.has(id) ? id : `${id}#mirror`)
    const ys = after.map((id) => ctx.thumbs.placed(thumbKey(id))?.dest.y ?? -1)
    check('live previews follow the new order', ys[0] >= 0 && ys[0] < ys[1], JSON.stringify(ys))

    // 11. a scrolled side list: previews stay inside the list and never paint over the title bar
    await js(`(() => { const s = document.querySelector('.focus-side'); s.style.height = '160px'; s.style.maxHeight = '160px'; s.scrollTop = 90 })()`)
    await sleep(700)
    const list = await js<Box | null>(`(() => {
      const s = document.querySelector('.focus-side')
      if (!s || s.scrollTop === 0 || s.scrollHeight <= s.clientHeight) return null
      const r = s.getBoundingClientRect()
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
    })()`)
    check('side list scrolls (precondition)', !!list, JSON.stringify(list))
    if (list) {
      const scale = screen.getDisplayMatching(ctx.window.getBounds()).scaleFactor
      const top = list.y * scale - 1
      const bottom = (list.y + list.height) * scale + 1
      const drawn = after.filter((id) => ctx.thumbs.has(thumbKey(id)))
      const inside = after.every((id) => {
        if (!ctx.thumbs.has(thumbKey(id))) return true // fully scrolled out: nothing drawn at all
        const p = ctx.thumbs.placed(thumbKey(id))
        return !!p && p.dest.y >= top && p.dest.y + p.dest.height <= bottom
      })
      const cut = after.some((id) => ctx.thumbs.has(thumbKey(id)) && !!ctx.thumbs.placed(thumbKey(id))?.source)
      check('scrolled previews stay inside the list', inside && drawn.length > 0, JSON.stringify({ top, bottom, placed: after.map((id) => ctx.thumbs.has(thumbKey(id)) && ctx.thumbs.placed(thumbKey(id))) }))
      check('a half-visible preview is cut, not squeezed', cut)
    }
    await js(`(() => { const s = document.querySelector('.focus-side'); s.style.height = ''; s.style.maxHeight = ''; s.scrollTop = 0 })()`)
    await sleep(500)

    // 12. dialogs are the top layer: every window parks below the app, no previews, and a terminal
    //     that comes forward while the dialog is open is sent back behind it
    const all = [conhost, terminal, worker]
    const allBelow = () => all.every((h) => ownerOf(h) === 0 && isAbove(app, h))
    for (const [label, text] of [['picker', 'Terminal einfangen'], ['workspaces', 'Workspaces']] as const) {
      ctx.window.focus()
      check(`${label}: dialog opened`, await clickText('.titlebar-actions .button', text))
      await sleep(900)
      const open = await js<boolean>(`!!document.querySelector('dialog[open]')`)
      const noPreviews = [a.id, b.id, c.id].every((id) => !ctx.thumbs.has(id))
      check(`${label}: all windows below the app, no previews`, open && allBelow() && noPreviews, `open=${open} owners=${all.map(ownerOf)} previews=${!noPreviews}`)
      await ax.setForeground(worker)
      await sleep(1800)
      check(`${label}: a terminal brought forward goes back below the dialog`, allBelow(), `owners=${all.map(ownerOf)} below=${all.map((h) => isAbove(app, h))}`)
      // Not a check: the foreground lock can leave the keyboard with the re-parked terminal (known limit).
      diagnostics[`${label}: foreground after re-park`] = { fg: String(w.GetForegroundWindow()), app: String(app), worker: String(worker) }
      await js(`document.querySelector('dialog[open] .dialog-head button')?.click()`)
      await sleep(900)
      check(`${label}: closing the dialog brings the big session back`, ownerOf(worker) === Number(app) && isAbove(worker, app))
    }

    // 12b. the picker stays open after a capture; the captured terminal leaves the list
    const extra = await spawnWindow('conhost', 'echo CLIO-SELFTEST-P')
    originals.push({ hwnd: extra.toString(), style: win.getStyle(extra), exStyle: win.getExStyle(extra), rect: rectOf(extra) })
    ctx.window.focus()
    check('picker opened again', await clickText('.titlebar-actions .button', 'Terminal einfangen'))
    await sleep(1200)
    const extraSel = JSON.stringify(`.candidate[data-hwnd="${extra}"] .button`)
    const listed = await js<boolean>(`(() => { const b = document.querySelector(${extraSel}); b?.click(); return !!b })()`)
    await sleep(1500)
    const stillOpen = await js<boolean>(`!!document.querySelector('dialog[open]')`)
    const stillListed = await js<boolean>(`!!document.querySelector(${extraSel})`)
    check('picker capture: the new terminal was listed and clicked', listed)
    check('picker stays open after capturing', stillOpen)
    check('captured terminal is captured and gone from the list', !!ctx.sessions.get(extra.toString()) && !stillListed)
    check('while the picker is open, the new terminal stays behind the app too', ownerOf(extra) === 0 && isAbove(app, extra))
    await js(`document.querySelector('dialog[open] .dialog-head button')?.click()`)
    await sleep(900)
    check('X closes the picker', !(await js<boolean>(`!!document.querySelector('dialog[open]')`)))
  }

  // 13. release from the page: the window gets its original frame back and leaves the journal
  const releaseId = await js<string | null>(`document.querySelector('.tile')?.dataset.id ?? null`)
  const released = await js<boolean>(`(() => {
    const btn = document.querySelector('.tile')?.querySelectorAll('.session-actions button')
    const last = btn?.[btn.length - 1]
    last?.click()
    return !!last
  })()`)
  await sleep(1000)
  const orig = originals.find((o) => o.hwnd === releaseId)
  const releasedHwnd = BigInt(releaseId ?? '0')
  check('release button clicked', released && !!orig, `id=${releaseId}`)
  if (orig) {
    check('released window has its original style back', win.getStyle(releasedHwnd) === orig.style && win.getExStyle(releasedHwnd) === orig.exStyle, `style=${win.getStyle(releasedHwnd).toString(16)} want=${orig.style.toString(16)}`)
    check('released window left the journal', !ctx.journal.entries().some((e) => e.hwnd === releaseId))
  }

  await agentChecks(ctx, check, js, clickText)
  await workspaceChecks(ctx, check, js, clickText)
  return report()
}

/**
 * 15. A workspace brings its windows back: a captured console window and an agent tile, both in a
 * folder of their own, get a name and a colour, are saved, closed, and come back from the workspace
 * in the same folder with the same name and colour. Workspaces go to a temp file in a test run.
 */
async function workspaceChecks(
  ctx: SelftestContext,
  check: (name: string, ok: boolean, detail?: string) => void,
  js: Js,
  clickText: (selector: string, text: string) => Promise<boolean>
): Promise<void> {
  check("a test run keeps workspaces out of the user's file", ctx.workspacesPath.startsWith(tmpdir()), ctx.workspacesPath)
  // Start from an empty organizer: the earlier steps' test windows go back (their originals are
  // restored exactly as on close) and their tiles end — so the workspace holds only this test's two.
  for (const s of ctx.sessions.list()) await ctx.sessions.release(s.id)
  for (const info of ctx.agents.infos()) await js(`window.organizer.removeAgent(${JSON.stringify(info.id)})`)
  await waitUntil(() => js<boolean>(`!document.querySelector('[data-id]')`), 5000)
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'clio-ws-')))
  const h = await spawnWindow('conhost', 'echo CLIO-WS', dir)
  const cap = await ctx.sessions.capture(h)
  const agent = await js<{ ok: boolean; id?: string }>(`window.organizer.startAgent(${JSON.stringify({ provider: 'cmd', role: 'plain', cwd: dir, task: '' })})`)
  check('workspace: window captured and tile started in the test folder', cap.ok && agent.ok && !!agent.id, JSON.stringify({ cap, agent }))
  if (!cap.ok || !agent.id) return
  const wid = cap.id
  const aid = agent.id
  // pictures for the visual check only (like clio-agent-tile.png); never a pass/fail
  const shot = async (name: string) => {
    try {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(tmpdir(), `clio-${name}.png`), (await ctx.window.webContents.capturePage()).toPNG())
    } catch {
      // visual aid only
    }
  }

  // name and colour through the page: the header's colour button opens the dialog
  await js(`document.querySelector('.side-card[data-id="${wid}"]')?.click()`)
  await waitUntil(() => js<boolean>(`!!document.querySelector('.tile[data-id="${wid}"] .style-button')`), 3000)
  await js(`document.querySelector('.tile[data-id="${wid}"] .style-button')?.click()`)
  const dialogOpen = await waitUntil(() => js<boolean>(`!!document.querySelector('dialog[open] #style-name')`), 3000)
  await js(`document.querySelector('dialog[open] #style-name')?.focus()`)
  for (const ch of 'CLIO-WS-CMD') ctx.window.webContents.sendInputEvent({ type: 'char', keyCode: ch })
  await sleep(200)
  await js(`document.querySelector('dialog[open] .swatch[title="Grün"] input')?.click()`)
  await sleep(200)
  await shot('style-dialog')
  await clickText('dialog[open] button', 'Übernehmen')
  const named = await waitUntil(() => js<boolean>(`(document.querySelector('.tile[data-id="${wid}"] .session-title')?.textContent ?? '') === 'CLIO-WS-CMD'`), 3000)
  check('name and colour dialog renames the session', dialogOpen && named)
  check('... and colours it', await js<boolean>(`!!document.querySelector('.tile[data-id="${wid}"] .session-header.has-color')`))
  await js(`window.organizer.setSessionStyle(${JSON.stringify(aid)}, { label: 'CLIO-WS-AGENT', color: 'blue' })`)

  // save: the dialog lists how each window comes back
  await js(`document.querySelector('.titlebar button:has(.workspace-label)')?.click()`)
  const rows = await waitUntil(() => js<boolean>(`[...document.querySelectorAll('.ws-window')].some(r => r.textContent.includes('CLIO-WS-CMD') && r.textContent.includes('Fenster, gleicher Ordner'))`), 5000)
  check('workspace dialog shows how the window comes back', rows)
  await js(`document.querySelector('#ws-name')?.focus()`)
  for (const ch of 'CLIO-SELFTEST-WS') ctx.window.webContents.sendInputEvent({ type: 'char', keyCode: ch })
  await sleep(200)
  await shot('workspace-dialog')
  await clickText('dialog[open] button[type="submit"]', 'Speichern')
  const saved = await waitUntil(async () => {
    const list = await js<Array<{ name: string; slots: Array<{ label?: string; color?: string; launch?: { kind: string; cwd: string | null } }> }>>('window.organizer.loadWorkspaces()')
    const ws = list.find((w) => w.name === 'CLIO-SELFTEST-WS')
    const win = ws?.slots.find((s) => s.label === 'CLIO-WS-CMD')
    const tile = ws?.slots.find((s) => s.label === 'CLIO-WS-AGENT')
    return win?.color === 'green' && win.launch?.kind === 'window' && win.launch.cwd === dir && tile?.launch?.kind === 'agent' && tile.launch.cwd === dir
  }, 5000)
  check('saved workspace holds name, colour and the folder of both', saved, dir)
  await js(`document.querySelector('dialog[open] .dialog-head button')?.click()`)
  await sleep(500)

  // close both
  await ctx.sessions.release(wid)
  w.PostMessageW(h, 0x0010, 0n, 0n) // WM_CLOSE: our own test window
  await js(`window.organizer.removeAgent(${JSON.stringify(aid)})`)
  const gone = await waitUntil(() => js<boolean>(`!document.querySelector('[data-id="${wid}"]') && !document.querySelector('[data-id="${aid}"]')`), 5000)
  check('workspace: both closed', gone && !win.isWindow(h))

  // apply: both come back
  await js(`(window.__clioErrors = [], addEventListener('unhandledrejection', e => window.__clioErrors.push(String(e.reason?.stack ?? e.reason))), addEventListener('error', e => window.__clioErrors.push(String(e.message))), true)`)
  await js(`document.querySelector('.titlebar button:has(.workspace-label)')?.click()`)
  await waitUntil(() => js<boolean>(`!!document.querySelector('dialog[open] .workspace')`), 3000)
  await js(`[...document.querySelectorAll('dialog[open] .workspace')].find(li => li.textContent.includes('CLIO-SELFTEST-WS'))?.querySelector('.button.is-primary')?.click()`)
  const byLabel = (label: string) =>
    js<{ id: string; label?: string; color?: string; agent?: unknown } | null>(
      `new Promise(r => { const off = window.organizer.onSessions(list => { off(); r(list.find(s => s.label === ${JSON.stringify(label)}) ?? null) }); window.organizer.ready() })`
    )
  let back: { id: string; color?: string } | null = null
  let backAgent: { id: string; color?: string } | null = null
  await waitUntil(async () => {
    back = await byLabel('CLIO-WS-CMD')
    backAgent = await byLabel('CLIO-WS-AGENT')
    return !!back && !!backAgent
  }, 30000)
  await sleep(600)
  await shot('workspace-restored')
  const pageErrors = await js<string>(`JSON.stringify(window.__clioErrors)`)
  check('workspace: restoring raised no error in the page', pageErrors === '[]', pageErrors)
  const b = back as { id: string; color?: string } | null
  const ba = backAgent as { id: string; color?: string } | null
  check('workspace: the window comes back, captured, with name and colour', !!b && b.color === 'green', JSON.stringify(b))
  check('workspace: the tile comes back with name and colour', !!ba && ba.color === 'blue', JSON.stringify(ba))
  if (b) {
    const hb = BigInt(b.id)
    check('... the window runs in the saved folder', processCwd(win.getPid(hb)) === dir + '\\', String(processCwd(win.getPid(hb))))
    check('... as a classic console window', win.getClassName(hb) === 'ConsoleWindowClass')
  }
  if (ba) check('... the tile runs in the saved folder', await waitUntil(() => ctx.agents.tail(ba.id, 20).includes(dir), 10000), ctx.agents.tail(ba.id, 4))
  check(
    'workspace: the notice says both came back',
    await waitUntil(() => js<boolean>(`(document.querySelector('.notice-slot')?.textContent ?? '').includes('2 Fenster wieder geöffnet')`), 5000),
    await js<string>(`JSON.stringify({ notice: document.querySelector('.notice-slot')?.textContent, titles: [...document.querySelectorAll('.side-title, .session-title')].map(e => e.textContent), dialog: !!document.querySelector('dialog[open]') })`)
  )

  // clean up: only what this test started
  if (b) {
    const hb = BigInt(b.id)
    await ctx.sessions.release(b.id)
    w.PostMessageW(hb, 0x0010, 0n, 0n)
  }
  if (ba) await js(`window.organizer.removeAgent(${JSON.stringify(ba.id)})`)
}

type Js = <T>(code: string) => Promise<T>

async function waitUntil(cond: () => Promise<boolean> | boolean, ms = 8000): Promise<boolean> {
  for (let t = 0; t < ms; t += 200) {
    if (await cond()) return true
    await sleep(200)
  }
  return cond()
}

/**
 * 14. Agent tiles: a terminal this app runs itself, used through the real keyboard path in every
 * view; then an orchestrator driving a worker through the REAL MCP shim and pipe, with a scripted
 * test client in place of an AI (reproducible, no model call).
 */
async function agentChecks(
  ctx: SelftestContext,
  check: (name: string, ok: boolean, detail?: string) => void,
  js: Js,
  clickText: (selector: string, text: string) => Promise<boolean>
): Promise<void> {
  // CLI startup and MCP checks share only this test-owned project, never the user's temp root.
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'clio-agent-')))

  // Every installed AI CLI really starts and stays up (no message is sent: no model call). Codex once
  // failed with "spawn-failed" because its npm shim was misread (2026-09-24).
  const installed = await js<string[]>('window.organizer.availableAgents()')
  const installedClaude = installed.includes('claude')
  for (const provider of installed.filter((p) => p === 'claude' || p === 'codex' || p === 'opencode')) {
    const r = await js<{ ok: boolean; id?: string; detail?: string }>(
      `window.organizer.startAgent(${JSON.stringify({ provider, role: 'plain', cwd, task: '' })})`
    )
    const alive = r.ok && r.id ? await waitUntil(() => ctx.agents.tail(r.id!, 60).trim().length > 0, 15000) : false
    check(`${provider} starts in a tile and shows output`, alive, JSON.stringify(r))
    // a plain AI tile knows the organizer: it gets the clio tools too (Marco, 2026-09-25)
    check(`${provider} (plain tile) was started with the organizer tools`, !!r.id && ctx.agents.toolsDelivered(r.id))
    if (r.id) await js(`window.organizer.removeAgent(${JSON.stringify(r.id)})`)
    await sleep(300)
  }

  const start = (role: 'plain' | 'orchestrator') =>
    js<{ ok: boolean; id?: string }>(`window.organizer.startAgent(${JSON.stringify({ provider: 'cmd', role, cwd, task: '' })})`)
  const a = await start('plain')
  check('agent tile starts (cmd)', a.ok && !!a.id, JSON.stringify(a))
  if (!a.ok || !a.id) return
  const aid = a.id
  const inTile = (inner: string) => JSON.stringify(`.tile[data-id="${aid}"] ${inner}`)
  const visible = () =>
    js<boolean>(`(() => { const x = document.querySelector(${inTile('.xterm')}); if (!x) return false; const r = x.getBoundingClientRect(); return r.width > 50 && r.height > 50 })()`)

  // focus view: first a small card with a text preview, a click makes it big
  check('focus: agent card in the side list', await waitUntil(() => js<boolean>(`!!document.querySelector('.side-card[data-id="${aid}"] .side-text')`)))
  await js(`document.querySelector('.side-card[data-id="${aid}"]')?.click()`)
  check('focus: agent tile big, terminal visible', await waitUntil(visible))
  // The terminal fits its tile: no row above or below the visible body ("content shifted up").
  await sleep(600)
  const fit = await js<{ body: number[]; screen: number[] } | null>(`(() => {
    const t = document.querySelector('.tile[data-id="${aid}"]')
    const b = t?.querySelector('.term-body')?.getBoundingClientRect()
    const s = t?.querySelector('.xterm-screen')?.getBoundingClientRect()
    return b && s ? { body: [b.top, b.bottom], screen: [s.top, s.bottom] } : null
  })()`)
  check('agent terminal fits inside its tile (top and bottom rows visible)', !!fit && fit.screen[0] >= fit.body[0] - 1 && fit.screen[1] <= fit.body[1] + 1, JSON.stringify(fit))
  try {
    const tileRect = await js<Box | null>(`(() => { const r = document.querySelector('.tile[data-id="${aid}"]')?.getBoundingClientRect(); return r ? { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } : null })()`)
    if (tileRect) {
      const img = await ctx.window.webContents.capturePage(tileRect)
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(tmpdir(), 'clio-agent-tile.png'), img.toPNG())
    }
  } catch {
    // the picture is a visual aid only
  }

  // real keyboard path: the page's terminal gets keystrokes, the program runs the command
  await js(`document.querySelector(${inTile('.xterm-helper-textarea')})?.focus()`)
  for (const ch of 'echo CLIO-AGENT-OK') ctx.window.webContents.sendInputEvent({ type: 'char', keyCode: ch })
  ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  ctx.window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  const echoed = () => ctx.agents.tail(aid, 40).split('\n').some((l) => l.trim() === 'CLIO-AGENT-OK')
  check('typing in the agent tile reaches the program', await waitUntil(echoed), ctx.agents.tail(aid, 8))
  check('the page shows the output', await waitUntil(() => js<boolean>(`(document.querySelector(${inTile('.xterm-rows')})?.textContent ?? '').includes('CLIO-AGENT-OK')`)))

  // Colours and cursor are drawn by a stylesheet xterm inserts at run time: the page's CSP once
  // blocked it and every tile was white on black with no cursor (Marco, 2026-09-25).
  for (const ch of 'powershell -NoProfile -Command "Write-Host CLIO-RED -ForegroundColor Red"') ctx.window.webContents.sendInputEvent({ type: 'char', keyCode: ch })
  ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  ctx.window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  const redColor = () =>
    js<string | null>(`(() => {
      const span = [...document.querySelectorAll(${inTile('.xterm-rows span')})].find(s => s.textContent === 'CLIO-RED')
      return span ? getComputedStyle(span).color : null
    })()`)
  await waitUntil(async () => (await redColor()) !== null, 10000)
  const red = await redColor()
  check('agent terminal draws colours (red text is red)', !!red && /^rgb\((\d+), (\d+), (\d+)\)$/.test(red) && Number(red.split(/[(,]/)[1]) > 150 && Number(red.split(',')[1]) < 120, String(red))
  await js(`document.querySelector(${inTile('.xterm-helper-textarea')})?.focus()`)
  await sleep(300)
  const cursor = await js<string | null>(`(() => {
    const c = document.querySelector(${inTile('.xterm-cursor')})
    if (!c) return null
    const before = getComputedStyle(c, '::before').backgroundColor
    const own = getComputedStyle(c)
    return JSON.stringify({ before, bg: own.backgroundColor, border: own.borderLeftColor, shadow: own.boxShadow, outline: own.outlineColor })
  })()`)
  check('agent terminal shows its cursor in the theme colour', !!cursor && cursor.includes('rgb(255, 209, 102)'), String(cursor))
  // pictures for the visual check only (the cursor blinks: two moments half a blink apart)
  for (const n of [1, 2]) {
    try {
      const r = await js<Box | null>(`(() => { const e = document.querySelector(${inTile('.term-body')})?.getBoundingClientRect(); return e ? { x: Math.round(e.left), y: Math.round(e.top), width: Math.round(e.width), height: Math.round(Math.min(e.height, 260)) } : null })()`)
      if (r) {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(join(tmpdir(), `clio-agent-colors-${n}.png`), (await ctx.window.webContents.capturePage(r)).toPNG())
      }
    } catch {
      // visual aid only
    }
    await sleep(600)
  }

  // select with the real mouse, copy with Ctrl+C; paste with Ctrl+V (cmd does not take the mouse)
  const screenBox = await js<Box | null>(`(() => { const r = document.querySelector(${inTile('.xterm-screen')})?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null })()`)
  await clipboard.writeText('')
  if (screenBox) {
    const y = Math.round(screenBox.y + 8)
    ctx.window.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(screenBox.x + 2), y, button: 'left', clickCount: 1 })
    ctx.window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(screenBox.x + 300), y: y + 60, button: 'left' })
    ctx.window.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(screenBox.x + 300), y: y + 60, button: 'left', clickCount: 1 })
    await sleep(300)
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] })
  }
  const copied = await waitUntil(async () => (await clipboard.readText()).trim().length > 0, 3000)
  check('mouse selection + Ctrl+C copies the text', copied, JSON.stringify((await clipboard.readText()).slice(0, 80)))
  // the ESC must be stripped (it could end a bracketed paste): unstripped, the echo would print a
  // CSI that the screen swallows, and the line would read CLIO-PASTE-OK without the [201~
  await clipboard.writeText('echo CLIO-PASTE\x1b[201~-OK')
  await js(`document.querySelector(${inTile('.xterm-helper-textarea')})?.focus()`)
  ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] })
  ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] })
  await sleep(500)
  ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  ctx.window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  check('Ctrl+V pastes into the tile, without control characters', await waitUntil(() => ctx.agents.tail(aid, 40).split('\n').some((l) => l.trim() === 'CLIO-PASTE[201~-OK')), ctx.agents.tail(aid, 6))

  // Voice input. The key ("-") tapped briefly still types a minus in the tile.
  await js(`document.querySelector(${inTile('.xterm-helper-textarea')})?.focus()`)
  const typeChars = (s: string) => {
    for (const ch of s) ctx.window.webContents.sendInputEvent({ type: 'char', keyCode: ch })
  }
  typeChars('echo CLIO')
  ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: '-' })
  ctx.window.webContents.sendInputEvent({ type: 'char', keyCode: '-' })
  ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: '-' })
  await sleep(150)
  typeChars('DASH')
  ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  ctx.window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  check('voice key: a short tap still types "-" (exactly one)', await waitUntil(() => ctx.agents.tail(aid, 20).split('\n').some((l) => l.trim() === 'CLIO-DASH')), ctx.agents.tail(aid, 4))
  // the microphone is granted for audio (NotAllowedError would mean the permission handler refuses it)
  const mic = await js<string>(`navigator.mediaDevices.getUserMedia({ audio: true }).then(s => { s.getTracks().forEach(t => t.stop()); return 'granted' }, e => e.name)`)
  check('voice: the microphone permission is granted for audio', mic !== 'NotAllowedError' && mic !== 'SecurityError', mic)
  // Real speech (Windows speech synthesis) through IPC, local Whisper, typed into the tile without Enter.
  try {
    const wav = join(tmpdir(), `clio-voice-${process.pid}.wav`)
    const { spawnSync } = await import('node:child_process')
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'de*' } | Select-Object -First 1; if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }; $s.SetOutputToWaveFile('${wav}'); $s.Speak('Hallo Organizer'); $s.Dispose()`], { windowsHide: true })
    const b64 = readFileSync(wav).toString('base64')
    rmSync(wav, { force: true })
    const r = await js<{ ok: boolean; text?: string; reason?: string; detail?: string }>(
      `window.organizer.transcribe(Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0)), ${JSON.stringify(aid)})`
    )
    if (!r.ok && r.reason === 'no-python') check('voice: no Python with faster-whisper here — the page says so', true, JSON.stringify(r))
    else {
      check('voice: speech is recognized locally', r.ok && /organi[sz]er/i.test(r.text ?? ''), JSON.stringify(r))
      const typed = await waitUntil(() => /organi[sz]er/i.test(ctx.agents.tail(aid, 3).split('\n').filter((l) => l.trim()).pop() ?? ''), 5000)
      check('voice: the text is typed into the tile, without Enter', typed, ctx.agents.tail(aid, 3))
      ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }) // cmd: clears the typed line
      ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    }
  } catch (err) {
    check('voice: speech is recognized locally', false, String(err))
  }

  // the quick-launch bar: PowerShell in a typed folder
  await js(`document.querySelector('.launch-folder')?.focus()`)
  for (const ch of cwd) ctx.window.webContents.sendInputEvent({ type: 'char', keyCode: ch })
  await sleep(200)
  const before = await js<number>(`document.querySelectorAll('[data-id^="a"]').length`)
  await clickText('.launch-bar .button', 'PowerShell')
  const bar = await waitUntil(async () => (await js<number>(`document.querySelectorAll('[data-id^="a"]').length`)) > before, 5000)
  const newest = await js<string | null>(`document.querySelector('.focus-main .tile')?.dataset.id ?? null`)
  check('launch bar opens PowerShell as a tile, shown big', bar && !!newest && newest !== aid, JSON.stringify({ before, newest }))
  if (newest) {
    check('... in the typed folder', await waitUntil(() => ctx.agents.tail(newest, 20).includes(cwd), 10000), ctx.agents.tail(newest, 4))
    await js(`window.organizer.removeAgent(${JSON.stringify(newest)})`)
    await sleep(500)
  }

  // unlock from the small card's agent icon (top right)
  const unlockCard = (on: boolean) =>
    waitUntil(() => js<boolean>(`document.querySelector('.side-card[data-id="${aid}"] ~ .card-unlock, li:has(> .side-card[data-id="${aid}"]) .card-unlock')?.getAttribute('aria-pressed') === ${JSON.stringify(String(on))}`), 3000)
  await js(`document.querySelector('li:has(> .side-card[data-id="${aid}"]) .card-unlock')?.click()`)
  check('card icon unlocks the tile for the orchestrator', await unlockCard(true))
  await js(`document.querySelector('li:has(> .side-card[data-id="${aid}"]) .card-unlock')?.click()`)
  check('... and locks it again', await unlockCard(false))

  // every other view shows the same terminal (scrollback survives the switch)
  for (const view of ['Raster', 'Frei', 'Tabs']) {
    await clickText('.view-button', view)
    await sleep(700)
    if (view === 'Tabs') await js(`document.getElementById('tab-${aid}')?.click()`)
    await sleep(400)
    check(`${view}: agent terminal visible with its history`, (await waitUntil(visible, 3000)) && (await js<boolean>(`(document.querySelector(${inTile('.xterm-rows')})?.textContent ?? '').includes('CLIO-AGENT-OK')`)))
  }
  await clickText('.view-button', 'Fokus')
  await sleep(700)
  await js(`document.querySelector('.side-card[data-id="${aid}"]')?.click()`)
  await sleep(500)

  // dock and back
  await js(`document.querySelector(${inTile('.session-actions button[title="Ins Dock legen"]')})?.click()`)
  check('dock: agent tile goes into the dock', await waitUntil(() => js<boolean>(`[...document.querySelectorAll('.dock-item')].length > 0`), 3000))
  await js(`document.querySelector('.dock-item')?.click()`)
  check('dock: back as a tile with its history', (await waitUntil(visible, 3000)) && echoed())

  // orchestrator through the real shim and pipe
  const o = await start('orchestrator')
  const ep = o.ok && o.id ? ctx.agents.mcpEndpoint(o.id) : null
  const node = findOnPath('node.exe', process.env.PATH ?? '')
  check('orchestrator tile with an MCP endpoint', !!ep && !!node, JSON.stringify({ o, ep: !!ep, node }))
  if (!ep || !node || !o.id) return
  const shimPath = app.isPackaged ? join(process.resourcesPath, 'clio-mcp.cjs') : join(app.getAppPath(), 'resources', 'clio-mcp.cjs')
  const client = spawn(node, [shimPath, '--pipe', ep.pipe], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    env: { ...process.env, CLIO_TOKEN: ep.token } // as the agent CLIs pass it: never on a command line
  })
  const replies = new Map<number, { result?: { tools?: unknown[]; content?: Array<{ text: string }>; isError?: boolean } }>()
  let buf = ''
  client.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      try {
        const msg = JSON.parse(line)
        replies.set(msg.id, msg)
      } catch {
        // not JSON: ignore
      }
    }
  })
  let nextId = 1
  const rpc = async (method: string, params: object = {}) => {
    const id = nextId++
    client.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    await waitUntil(() => replies.has(id), 20000)
    return replies.get(id)
  }
  const tool = async (name: string, args: object) => {
    const r = await rpc('tools/call', { name, arguments: args })
    return { error: !!r?.result?.isError, text: r?.result?.content?.[0]?.text ?? '' }
  }
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } })
    const list = await rpc('tools/list')
    const toolNames = (list?.result?.tools ?? []).map(value => (value as { name?: string }).name)
    check('MCP via shim: tools listed', ['read_screen', 'spawn_worker', 'send', 'wait_for', 'read_tail', 'stop_worker', 'list_contracts', 'run_contract_check'].every(name => toolNames.includes(name)), JSON.stringify(toolNames))
    const projectAdded = await js<{ ok: boolean }>(`window.organizer.cockpitCommand({ type: 'add-project', root: ${JSON.stringify(cwd)} })`)
    check('MCP via shim: calling folder registered as a cockpit project', projectAdded.ok)
    const contracts = await tool('list_contracts', {})
    check('MCP via shim: own-folder contracts available', !contracts.error, contracts.text)
    const project = (await js<import('../shared/cockpit').CockpitSnapshot>('window.organizer.loadCockpit()')).projects.find(item => item.root.toLowerCase() === cwd.toLowerCase())
    if (!project) throw new Error('MCP fixture project missing')
    const created = await js<{ ok: boolean }>(`window.organizer.cockpitCommand(${JSON.stringify({ type: 'create-contract', projectId: project.id, title: 'MCP check fixture', objective: 'Prove the real MCP-to-runner path', maxSessions: 2, maxHours: 1, command: 'echo CLIO-MCP-CHECK' })})`)
    if (!created.ok) throw new Error('MCP fixture contract missing')
    const contract = (await js<import('../shared/cockpit').CockpitSnapshot>('window.organizer.loadCockpit()')).projects.find(item => item.id === project.id)!.contracts[0]
    const frozen = await js<{ ok: boolean }>(`window.organizer.cockpitCommand(${JSON.stringify({ type: 'freeze-contract', projectId: project.id, contractId: contract.id, approvedBy: 'Selftest fixture', expectedDefinitionHash: contract.definitionHash })})`)
    if (!frozen.ok) throw new Error('MCP fixture freeze failed')
    const checked = await tool('run_contract_check', { contract_id: contract.id })
    const proof = (await js<import('../shared/cockpit').CockpitSnapshot>('window.organizer.loadCockpit()')).projects.find(item => item.id === project.id)!.contracts.find(item => item.id === contract.id)!
    check('MCP via shim: actual frozen check executes and persists without manual approval', !checked.error && proof.runs[0]?.passed === true && proof.runs[0].stdout.includes('CLIO-MCP-CHECK') && !proof.fulfilled && proof.manualApprovals.length === 0, checked.text)
    const denied = await tool('read_screen', { id: aid })
    check("MCP: reading the user's tile is refused until it is unlocked", denied.error && /not allowed/.test(denied.text), denied.text)
    const spawned = await tool('spawn_worker', { provider: 'cmd', cwd })
    const wid = spawned.error ? null : (JSON.parse(spawned.text) as { id: string }).id
    check('MCP: spawn_worker starts a worker tile', !!wid, spawned.text)
    if (wid) {
      check('worker tile shows up marked as worker', await waitUntil(() => js<boolean>(`!!document.querySelector('.side-card[data-id="${wid}"]') || !!document.querySelector('.tile[data-id="${wid}"] .chip')`)))
      const sent = await tool('send', { id: wid, text: 'echo CLIO-MCP-OK' })
      check('MCP: send types into the worker', !sent.error, sent.text)
      const waited = await tool('wait_for', { id: wid, pattern: 'CLIO-MCP-OK', timeout_s: 15 })
      check('MCP: wait_for sees the output', !waited.error && JSON.parse(waited.text).matched === true, waited.text)
      const tail = await tool('read_tail', { id: wid, lines: 20 })
      check('MCP: read_tail returns the result line', tail.text.split('\n').some((l) => l.trim() === 'CLIO-MCP-OK'), tail.text)
      const stopped = await tool('stop_worker', { id: wid })
      check('MCP: stop_worker ends its own worker', !stopped.error, stopped.text)
    }
    // A Claude worker in a NEW folder below the orchestrator's own: the organizer answers "Trust this
    // folder?" (Marco, 2026-09-25). No message is sent to Claude: no model call.
    if (installedClaude) {
      const sub = realpathSync.native(mkdtempSync(join(cwd, 'clio-trust-')))
      const cw = await tool('spawn_worker', { provider: 'claude', cwd: sub })
      const cid = cw.error ? null : (JSON.parse(cw.text) as { id: string }).id
      // First the dialog must really appear (a folder Claude already trusts would pass vacuously), then
      // it must go, and the answer must be in the audit log (cold review).
      const asked = cid ? await waitUntil(() => /Yes, I trust this folder/.test(ctx.agents.tail(cid, 40)), 20000) : false
      const answered = asked && cid
        ? await waitUntil(() => {
            const t = ctx.agents.tail(cid, 40)
            return !/Yes, I trust this folder/.test(t) && /Claude Code v/.test(t)
          }, 20000)
        : false
      const auditFile = join(dirname(ctx.journalPath), 'agent-audit.log')
      const logged = !!cid && existsSync(auditFile) && readFileSync(auditFile, 'utf8').split('\n').some((l) => l.includes('"auto-trust"') && l.includes(`"tile":"${cid}"`))
      check('Claude worker in its own folder: the organizer answers the trust question', asked && answered && logged, JSON.stringify({ asked, answered, logged, tail: cid ? ctx.agents.tail(cid, 60) : cw.text }))
      if (cid) await tool('stop_worker', { id: cid })
      await sleep(1500)
      try {
        rmSync(sub, { recursive: true, force: true })
      } catch {
        // Claude may still hold the folder for a moment; it is in the temp folder either way
      }
    }
    await js(`document.querySelector(${inTile('.unlock-button')})?.click()`)
    await sleep(400)
    const allowed = await tool('read_screen', { id: aid })
    check('MCP: after unlocking, the tile can be read', !allowed.error && allowed.text.includes('CLIO-AGENT-OK'), allowed.text.slice(0, 200))
    const notStoppable = await tool('stop_worker', { id: aid })
    check("MCP: an unlocked tile still cannot be stopped (it is not the orchestrator's worker)", notStoppable.error, notStoppable.text)
  } finally {
    client.stdin.end()
  }

  // stop asks once more, then the ended tile can be closed
  await js(`document.querySelector(${inTile('.session-actions button[title="Beenden"]')})?.click()`)
  await sleep(200)
  check('stop asks for confirmation', await clickText(`.tile[data-id="${aid}"] .session-actions button`, 'Wirklich beenden?'))
  check('stopped tile shows "Beendet"', await waitUntil(() => js<boolean>(`(document.querySelector(${inTile('.session-meta')})?.textContent ?? '').includes('Beendet')`), 5000))
  await js(`document.querySelector(${inTile('.session-actions .icon-button')})?.click()`)
  check('closing an ended tile removes it', await waitUntil(() => js<boolean>(`!document.querySelector('[data-id="${aid}"]')`), 5000))
}
