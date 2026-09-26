import { mkdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { resolveLang } from '../shared/lang'
import type { CaptureCandidate, CaptureResult, Lang, SessionInfo } from '../shared/types'
import { parseAgentId, parseId, parseIdList, parseLang, parseLayout, parseSessionId, parseWorkspaces } from '../shared/validate'
import { ActivityMonitor } from './activity/monitor'
import { wireAgents } from './agents/wire'
import { DragWatcher } from './capture/dragwatch'
import { claimedByOtherInstances, instanceJournalPath, journalsOfDeadInstances, type Liveness } from './capture/instances'
import { awaitRelease, claimKind, clearHandover, handoversFor, requestHandover } from './capture/handover'
import { Journal } from './capture/journal'
import { recoverOrphans, SessionManager } from './capture/sessions'
import { Placer } from './placement/placer'
import { wireRestore, type RestoreWiring } from './restore/wire'
import { wireVoice } from './voice/wire'
import { Thumbnails } from './placement/thumbs'
import { runSelftest } from './selftest'
import * as w from './win32/api'
import * as ax from './win32/async'
import type { HWND } from './win32/api'
import { launchIndependent, systemDirectory } from './win32/launch'
import * as win from './win32/windows'

const TICK_MS = 1000
const SHUTDOWN_TIMEOUT_MS = 5000
const HANDOVER_TIMEOUT_MS = 5000


// The page must keep rendering whatever lies on top of the window: it measures the slots every frame
// and the captured windows follow it. Chromium's occlusion tracking marked the page hidden while
// captured windows surrounded it (measured in the selftest: visibilityState hidden, 0 animation
// frames, although the app was the visible foreground window) and the windows stopped following.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// Several instances may run side by side (button "Neue Instanz"); each has its own journal and watchdog.
app
  .whenReady()
  .then(start)
  .catch((err) => {
    console.error(err)
    app.exit(1)
  })

/** Starts another organizer: through the portable wrapper when there is one, else this executable. */
function launchNewInstance(): void {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  const exe = portable ?? process.execPath
  const args = portable || app.isPackaged ? [] : [app.getAppPath()]
  try {
    if (launchIndependent(exe, args) === null) console.error('could not start a new instance')
  } catch (err) {
    console.error('could not start a new instance', err) // never out of an IPC handler
  }
}

/**
 * The instance that wrote a journal is alive when a process with that id AND start time runs.
 * Versions before multi-instance support hold the single-instance lock while they run; probing it
 * is side-effect free for them (they have no second-instance handler). Two new instances probing at
 * the same moment may see each other as "old version runs" — that only skips work, never restores.
 */
const legacyProbe = { at: 0, alive: false }
const liveness: Liveness = {
  isAlive: (pid, start) => win.processStartTime(pid) === start,
  get legacyAlive() {
    // Probing notifies the lock holder; only asked while a legacy journal exists, and at most every 10 s.
    if (Date.now() - legacyProbe.at > 10_000) {
      const held = !app.requestSingleInstanceLock()
      if (!held) app.releaseSingleInstanceLock()
      legacyProbe.at = Date.now()
      legacyProbe.alive = held
    }
    return legacyProbe.alive
  }
}

/**
 * Starts the watchdog (resources/watchdog.ps1) that restores captured windows if this process dies.
 * Measured on this machine: with the watchdog as an electron.exe Node-mode child, or as a Node
 * `spawn` child at all, the app hung on quit; launched independently via CreateProcessW it quit
 * cleanly in 4 of 4 runs.
 */
function spawnWatchdog(journalPath: string, logPath: string): void {
  const script = app.isPackaged
    ? join(process.resourcesPath, 'watchdog.ps1')
    : join(app.getAppPath(), 'resources', 'watchdog.ps1')
  const start = win.processStartTime(process.pid)
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
  args.push('-ParentPid', String(process.pid), '-Journal', journalPath, '-Log', logPath)
  if (start) args.push('-ParentStart', start)
  // Not Node's spawn: a non-detached child sits in libuv's kill-on-close job (and the app hung on
  // quit with it alive), a detached PowerShell never ran the script (both measured).
  // Absolute path from the OS: a bare name would be searched in the (user-writable) app directory first.
  const powershell = join(systemDirectory(), 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (launchIndependent(powershell, args) === null) {
    console.error('watchdog could not be started; crash recovery falls back to the next app start')
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function atomicWrite(file: string, data: string): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

async function start(): Promise<void> {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const dataDir = app.getPath('userData')
  mkdirSync(dataDir, { recursive: true })
  const selfStart = win.processStartTime(process.pid) ?? String(Date.now())
  const journalPath = instanceJournalPath(dataDir, process.pid, selfStart)
  const testRun = !!(arg('selftest') || arg('selftest-hold'))
  // A selftest saves workspaces too: never into the user's file.
  const workspacesPath = testRun ? join(tmpdir(), `clio-selftest-workspaces-${process.pid}.json`) : join(dataDir, 'workspaces.json')
  const settingsPath = join(dataDir, 'settings.json')
  const journal = new Journal(journalPath)

  // Windows that crashed instances left behind come back first — only from instances that are no
  // longer running, never from a sibling instance. Never at the price of a start that cannot finish:
  // a restore still running after the wait goes on in the background (it only touches its own files).
  const recoverDead = async () => {
    for (const file of journalsOfDeadInstances(dataDir, journalPath, liveness)) {
      const orphan = new Journal(file)
      await recoverOrphans(orphan)
      if (orphan.entries().length === 0) rmSync(file, { force: true })
    }
  }
  await Promise.race([recoverDead(), delay(SHUTDOWN_TIMEOUT_MS)])
  spawnWatchdog(journalPath, join(dataDir, 'watchdog.log'))

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    frame: false,
    show: false,
    title: 'CLI Organizer',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // see the occlusion switch at the top: slot sync must never pause
      nodeIntegration: false
    }
  })
  const appHwnd = (): HWND => window.getNativeWindowHandle().readBigUInt64LE()

  const sessions = new SessionManager(journal, {
    ownWindows: () => (window.isDestroyed() ? [] : [appHwnd()]),
    selfElevated: win.isProcessElevated(process.pid),
    // Read fresh at every capture: the other instance journals a window before it touches it.
    claimedElsewhere: (id) => claimedByOtherInstances(dataDir, journalPath).has(id)
  })
  const thumbs = new Thumbnails(appHwnd)
  let attended: string[] = []
  const monitor = new ActivityMonitor({
    sessions: () => sessions.list(),
    // The foreground window only counts while it is actually visible: a parked window can stay the
    // OS foreground window while hidden behind the app (seen in the selftest), unseen by the user.
    isAttended: (s) => attended.includes(s.id) || (placer.isLive(s.id) && w.GetForegroundWindow() === s.hwnd),
    paused: () => placer.isHidden()
  })
  const placer = new Placer(window, sessions, thumbs, { sizeChanged: (id) => monitor.settle(id) })

  const send = (channel: string, value: unknown) => {
    if (!window.isDestroyed()) window.webContents.send(channel, value)
  }
  let displaced = new Set<string>()
  const sessionInfos = (): SessionInfo[] => [
    ...sessions.list().map((s) => ({
      id: s.id,
      title: s.title,
      className: s.className,
      processName: s.processName,
      alive: true,
      displaced: displaced.has(s.id),
      ...monitor.info(s.id)
    })),
    ...agents.infos()
  ]
  // decorate is wired after the agents; a push before that (agent start-up) goes out undecorated.
  let restore: RestoreWiring | null = null
  const push = () => send('sessions', restore ? restore.decorate(sessionInfos()) : sessionInfos())
  // Agent tiles: terminals this app runs itself (node-pty), plus the orchestrator MCP pipe.
  const agents = await wireAgents(window, dataDir, () => push(), () =>
    sessions.list().map((s) => ({ title: s.title, program: s.processName }))
  )
  // Names and colours of sessions, and workspaces that start their missing windows again.
  restore = wireRestore({
    captured: (id) => sessions.get(id),
    capture: (h) => sessions.capture(h),
    agentInfos: () => agents.infos(),
    startAgent: (start) => agents.start(start),
    home: homedir(),
    isDir: (p) => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    },
    push: () => push()
  })

  let shuttingDown = false
  sessions.on('changed', push)
  sessions.on('removed', (id) => {
    placer.forget(id)
    monitor.forget(id)
    // During shutdown a re-layout would re-own windows that detachAll just released.
    if (!shuttingDown) placer.apply()
  })

  /** notify: show a refusal as the app notice (a drop); the picker shows it in the dialog itself. */
  const captureAndReport = async (h: HWND, notify: boolean): Promise<CaptureResult> => {
    const result = await sessions.capture(h)
    if (result.ok) send('captured', result.id)
    else if (notify) send('notice', result.reason) // the page words it in its language
    return result
  }

  // A window another instance holds: ask it to release the window, wait for its original to come
  // back, then capture it here like any other (so this journal records the real original).
  const takeOver = async (h: HWND, notify: boolean): Promise<CaptureResult> => {
    const id = h.toString()
    const kind = claimKind(dataDir, journalPath, id, liveness.isAlive)
    const refuse = (reason: 'legacy-instance' | 'stale-instance' | 'handover-timeout'): CaptureResult => {
      if (notify) send('notice', reason)
      return { ok: false, reason }
    }
    if (kind === 'legacy') return refuse('legacy-instance')
    if (kind === 'stale') return refuse('stale-instance')
    if (kind === 'instance') {
      requestHandover(dataDir, id, { pid: process.pid, start: selfStart })
      const released = await awaitRelease(() => claimedByOtherInstances(dataDir, journalPath).has(id), HANDOVER_TIMEOUT_MS)
      clearHandover(dataDir, id)
      if (!released) return refuse('handover-timeout')
    }
    return captureAndReport(h, notify)
  }

  // Another instance asked for one of this instance's windows: release it (and nothing else).
  // sessions.release drops the session synchronously, so a second trigger cannot release it twice.
  const serveHandovers = () => {
    for (const id of handoversFor(dataDir, (x) => !!sessions.get(x), liveness.isAlive)) {
      placer.forget(id)
      monitor.forget(id)
      void sessions.release(id).finally(() => clearHandover(dataDir, id))
    }
  }
  let handoverWatch: ReturnType<typeof watch> | null = null
  try {
    handoverWatch = watch(dataDir, (_event, name) => {
      if (typeof name === 'string' && name.startsWith('handover-')) serveHandovers()
    })
  } catch {
    // no file watching: the 1 s tick still serves requests
  }

  const selfImage = win.processImageName(process.pid)
  const drag = new DragWatcher({
    appWindow: window,
    eligible: (h) =>
      !sessions.get(h.toString()) && h !== appHwnd() && win.isConsoleWindow(h) && win.isVisible(h),
    captured: (h) => !!sessions.get(h.toString()),
    // Another organizer: an Electron window of the same executable (several instances may overlap).
    rival: (h) => selfImage !== null && h !== appHwnd() && win.getClassName(h) === 'Chrome_WidgetWin_1' && win.processImageName(win.getPid(h)) === selfImage,
    onState: (s) => send('drag', s),
    onDrop: (h, kind) => {
      if (kind === 'reseat') placer.reseat([h.toString()])
      else void takeOver(h, true)
    }
  })

  const tick = setInterval(() => {
    sessions.refresh()
    serveHandovers() // fallback when the folder watch missed a request
    // A dialog must stay on top: a captured window that came to the front goes back behind the app.
    // Keyboard focus may stay with the re-parked terminal: the foreground lock refuses focus() from the
    // background (measured in 2 of 2 selftest runs). What the user sees — the dialog on top — holds.
    if (placer.guardModal(w.GetForegroundWindow() as HWND | null)) window.focus()
    const nowDisplaced = new Set(placer.displacedIds())
    const displacedChanged = nowDisplaced.size !== displaced.size || [...nowDisplaced].some((id) => !displaced.has(id))
    displaced = nowDisplaced
    const agentsChanged = agents.tick(attended)
    void monitor.tick().then((changed) => (changed || displacedChanged || agentsChanged) && push())
  }, TICK_MS)

  for (const ev of ['move', 'resize', 'maximize', 'unmaximize'] as const) window.on(ev as 'move', () => placer.apply())
  window.on('minimize', () => {
    monitor.markAway()
    placer.hideAll()
  })
  window.on('restore', () => placer.showAll())

  // ---- IPC (every payload is validated; the page is not trusted with raw handles) ----
  ipcMain.on('ready', () => push())
  ipcMain.on('layout', (_e, raw) => {
    const layout = parseLayout(raw)
    if (!layout) return
    attended = layout.attended
    for (const id of attended) monitor.clearBadge(id)
    const dialogOpened = !!layout.modal && !placer.current().modal
    placer.setLayout(layout)
    if (dialogOpened) window.focus() // the dialog lives in the app window: bring it in front of everything
  })
  ipcMain.on('reseat', (_e, raw) => {
    const ids = raw === undefined ? undefined : parseIdList(raw)
    if (ids === null) return
    placer.reseat(ids)
  })
  ipcMain.handle('capture', (_e, raw): Promise<CaptureResult> | CaptureResult => {
    const id = parseId(raw)
    return id ? takeOver(BigInt(id), false) : { ok: false, reason: 'unsupported' }
  })
  ipcMain.handle('release', async (_e, raw) => {
    const id = parseId(raw)
    if (!id) return
    placer.forget(id)
    monitor.forget(id)
    await sessions.release(id)
  })
  ipcMain.on('focus-session', (_e, raw) => {
    if (parseAgentId(raw)) {
      agents.clearBadge(raw) // an agent tile gets keyboard focus inside the page
      return push()
    }
    const s = sessions.get(parseId(raw) ?? '')
    if (!s) return
    monitor.clearBadge(s.id)
    void ax.setForeground(s.hwnd)
    push()
  })
  ipcMain.on('clear-badge', (_e, raw) => {
    const id = parseSessionId(raw)
    if (!id) return
    monitor.clearBadge(id)
    agents.clearBadge(id)
    push()
  })
  ipcMain.handle('candidates', (): CaptureCandidate[] => {
    // Every console window except this instance's own; those of another organizer are marked.
    return win
      .listConsoleWindows()
      .filter((h) => h !== appHwnd() && !sessions.get(h.toString()))
      .map((h): CaptureCandidate => {
        const heldBy = claimKind(dataDir, journalPath, h.toString(), liveness.isAlive)
        return {
          hwnd: h.toString(),
          title: win.getTitle(h),
          className: win.getClassName(h),
          processName: win.processImageName(win.getPid(h)) ?? win.getClassName(h),
          ...(heldBy ? { heldBy } : {})
        }
      })
  })
  ipcMain.handle('workspaces:load', () => {
    try {
      return parseWorkspaces(JSON.parse(readFileSync(workspacesPath, 'utf8'))) ?? []
    } catch {
      return []
    }
  })
  // --lang= (selftest, e2e) overrides without saving; a selftest never writes the user's settings.
  const langOverride = parseLang(arg('lang'))
  const currentLang = (): Lang => {
    let saved: Lang | null = null
    try {
      saved = parseLang(JSON.parse(readFileSync(settingsPath, 'utf8'))?.lang)
    } catch {
      // no settings yet: follow Windows
    }
    return resolveLang({ override: langOverride, saved, system: app.getPreferredSystemLanguages() })
  }
  ipcMain.handle('settings:load', () => currentLang())
  // settings.json holds several parts (language, voice input): each save merges, never replaces.
  const readSettings = (): Record<string, unknown> => {
    try {
      const v = JSON.parse(readFileSync(settingsPath, 'utf8'))
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}
    } catch {
      return {}
    }
  }
  const saveSettings = (patch: Record<string, unknown>) => {
    if (!testRun) atomicWrite(settingsPath, JSON.stringify({ ...readSettings(), ...patch }))
  }
  ipcMain.handle('settings:save', (_e, raw) => {
    const lang = parseLang(raw)
    if (!lang) return false
    saveSettings({ lang })
    return true
  })
  // Voice input: local Whisper, typed into the chosen tile (agents: PTY; captured windows: keystrokes).
  const voice = wireVoice({
    settings: () => readSettings().voice,
    saveSettings: (v) => saveSettings({ voice: v }),
    writeAgent: (id, text) => agents.write(id, text),
    captured: (id) => sessions.get(id)
  })
  // The microphone, and nothing else: only audio, only for this app's own page.
  window.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => {
    const media = details as { mediaTypes?: string[] }
    callback(wc === window.webContents && permission === 'media' && !!media.mediaTypes?.length && media.mediaTypes.every((t) => t === 'audio'))
  })
  window.webContents.session.setPermissionCheckHandler((wc, permission, _origin, details) => wc === window.webContents && permission === 'media' && details.mediaType === 'audio')
  ipcMain.handle('workspaces:save', (_e, raw) => {
    const list = parseWorkspaces(raw)
    if (list) atomicWrite(workspacesPath, JSON.stringify(list, null, 1))
    return list !== null
  })
  ipcMain.on('window', (_e, action) => {
    if (action === 'minimize') window.minimize()
    else if (action === 'maximize') (window.isMaximized() ? window.unmaximize() : window.maximize())
    else if (action === 'close') window.close()
  })
  ipcMain.on('new-instance', () => launchNewInstance())

  // ---- Shutdown: every captured window goes back before the app window disappears ----
  const shutdown = async () => {
    drag.stop()
    clearInterval(tick)
    handoverWatch?.close()
    agents.stopAll() // started agents end with the app (captured windows keep running)
    voice.stop()
    agents.close()
    // One deadline for both steps: detaching a hung window blocks just like restoring it.
    await Promise.race([placer.detachAll().then(() => sessions.releaseAll()), delay(SHUTDOWN_TIMEOUT_MS)])
    // Anything that did not restore in time stays in the journal; the watchdog retries it after exit.
    // A clean exit leaves no file behind (one journal per instance would otherwise pile up).
    if (journal.entries().length === 0) rmSync(journalPath, { force: true })
  }
  let asking = false
  window.on('close', (e) => {
    if (shuttingDown) return
    e.preventDefault()
    if (asking) return
    void (async () => {
      const running = agents.running()
      if (running > 0 && !testRun) {
        // Started agents are processes of this app: closing ends them. Say so first.
        asking = true
        const de = currentLang() === 'de'
        const r = await dialog.showMessageBox(window, {
          type: 'question',
          buttons: de ? ['Beenden und schließen', 'Abbrechen'] : ['Stop them and close', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: de ? `${running} gestartete Agenten laufen noch.` : `${running} started agents are still running.`,
          detail: de
            ? 'Beim Schließen werden sie beendet. Eingefangene Terminals laufen weiter.'
            : 'Closing ends them. Captured terminals keep running.'
        })
        asking = false
        if (r.response !== 0) return
      }
      shuttingDown = true
      try {
        await shutdown()
      } catch (err) {
        console.error('shutdown step failed; closing anyway (the watchdog restores what is left)', err)
      } finally {
        window.destroy() // never leave a window that can no longer be closed
      }
    })()
  })
  app.on('window-all-closed', () => app.quit())

  window.once('ready-to-show', () => window.show())
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(__dirname, '../renderer/index.html'))
  drag.start()

  const selftestOut = arg('selftest')
  const holdOut = arg('selftest-hold')
  if (selftestOut || holdOut) {
    const foreign = arg('selftest-foreign') ?? null // a window another instance holds (two-instance e2e)
    const report = await runSelftest({ window, sessions, placer, thumbs, agents, monitor, journal, journalPath, workspacesPath }, !!holdOut, foreign)
    atomicWrite((selftestOut ?? holdOut)!, JSON.stringify(report, null, 2))
    if (selftestOut) window.close()
  }
}
