// Connects agent tiles to the app: node-pty processes, the page (IPC), badges and the orchestrator
// MCP pipe. index.ts only asks it for session infos, ticks it and stops it on shutdown.
import { mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, clipboard, dialog, ipcMain, type BrowserWindow } from 'electron'
import * as nodePty from 'node-pty'
import type { AgentProvider, AgentRole, AgentStart, SessionInfo } from '../../shared/types'
import { detectTrustPrompt, normalizeFolder, parseClipboardText } from '../../shared/folder'
import { parseAgentId, parseAgentStart, parseTerminalSize } from '../../shared/validate'
import { systemDirectory } from '../win32/launch'
import { AgentActivity } from './activity'
import { AgentManager, type StartResult } from './agents'
import { AuditLog, McpHandler } from './mcp'
import { autoTrust, isTrustDialogFor, trustKeys } from './trust'
import { McpPipe } from './pipe'
import { findOnPath, resolveProgram } from './programs'
import { loadPrompts } from './prompts'
import { buildLaunch, hasOrganizerTools, type McpLink } from './providers'

const PROVIDERS: AgentProvider[] = ['claude', 'codex', 'opencode', 'cmd', 'pwsh']
const MAX_INPUT = 64 * 1024
const FLUSH_MS = 16
const TRUST_KEY_GAP_MS = 200 // measured spike: one key per 150 ms was taken
const TRUST_WINDOW_MS = 30_000 // Claude shows its trust dialog right after start
const TRUST_USER_QUIET_MS = 1500 // same pause as an orchestrator's send

export type AgentWiring = {
  infos(): SessionInfo[]
  /** One activity pass; true when a tile's activity or badge changed. */
  tick(attended: string[]): boolean
  clearBadge(id: string): void
  running(): number
  stopAll(): void
  close(): void
  /** Selftest: what the tile's screen shows, and the pipe + token its MCP shim would use. */
  tail(id: string, lines: number): string
  mcpEndpoint(orchestrator: string): { pipe: string; token: string } | null
  /** A workspace restore starts a tile it saved (folder checked by AgentManager, resume only from here). */
  start(start: AgentStart): StartResult
  /** Selftest: the tile's program was started with the clio MCP config (file or environment). */
  toolsDelivered(id: string): boolean
  /** Voice input: text typed into a tile as if by the user (no Enter is added). */
  write(id: string, text: string): boolean
}

export async function wireAgents(
  window: BrowserWindow,
  dataDir: string,
  onChange: () => void,
  captured: () => Array<{ title: string; program: string }>
): Promise<AgentWiring> {
  const home = homedir()
  const pathEnv = process.env.PATH ?? ''
  const sys = systemDirectory()
  const programs = new Map(PROVIDERS.map((p) => [p, resolveProgram(p, pathEnv, sys)]))
  const node = findOnPath('node.exe', pathEnv) ?? 'node.exe'
  const shim = app.isPackaged ? join(process.resourcesPath, 'clio-mcp.cjs') : join(app.getAppPath(), 'resources', 'clio-mcp.cjs')
  // The child environment: everything but Electron's own switches.
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string' && !e[0].startsWith('ELECTRON_'))
  )

  let pipe: McpPipe | null = null
  const delivered = new Set<string>()
  const agents = new AgentManager({
    spawn: (file, args, o) => nodePty.spawn(file, args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env, useConpty: true }),
    program: (p) => programs.get(p) ?? null,
    launch: (start, id) => {
      const mcp: McpLink = {
        node,
        shim,
        pipe: pipe?.name ?? '',
        token: hasOrganizerTools(start.provider, start.role) && pipe ? pipe.issue(id) : '',
        configFile: join(dataDir, 'mcp', `${id}-${process.pid}.json`)
      }
      const launch = buildLaunch({ ...start, prompts: loadPrompts(dataDir), mcp })
      // what the program really received (selftest: the delivery, not just the rule)
      const hasConfig = launch.files.length > 0 || 'CLIO_TOKEN' in launch.env || 'OPENCODE_CONFIG_CONTENT' in launch.env
      if (hasConfig && mcp.token !== '') delivered.add(id)
      return launch
    },
    isDir: (p) => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    },
    baseEnv,
    writeFile: (path, content) => {
      mkdirSync(join(dataDir, 'mcp'), { recursive: true })
      writeFileSync(path, content)
    },
    removeFile: (path) => rmSync(path, { force: true })
  })
  const audit = new AuditLog(join(dataDir, 'agent-audit.log'))

  // A Claude worker in its starting tile's folder: the organizer answers "Trust this folder?" itself
  // (see trust.ts). Once per worker; the keys go one by one, as Claude's UI reads them.
  // Armed only while the worker starts up (cold review): later, text that merely looks like the dialog
  // (an answer, a file, a repo) must never get these keys. Disarmed for good once Claude is ready, once
  // answered, or after TRUST_WINDOW_MS.
  const trustDone = new Set<string>()
  const trustSince = new Map<string, number>()
  const real = (p: string) => {
    try {
      return realpathSync.native(p) // 8.3 names and junctions resolved before the folders are compared
    } catch {
      return null
    }
  }
  const answerTrust = (a: {
    id: string
    provider: AgentProvider
    role: AgentRole
    cwd: string
    parentId: string | null
    lastUserInputAt: number
    screen: { visibleLines(): string[] }
  }) => {
    if (trustDone.has(a.id) || a.provider !== 'claude' || a.role !== 'worker') return
    const now = Date.now()
    const since = trustSince.get(a.id) ?? now
    trustSince.set(a.id, since)
    const lines = a.screen.visibleLines()
    const dialog = detectTrustPrompt(lines)
    if (now - since > TRUST_WINDOW_MS || (!dialog && lines.some((l) => /Claude Code v/.test(l)))) {
      trustDone.add(a.id)
      trustSince.delete(a.id)
      return
    }
    if (!dialog || now - a.lastUserInputAt < TRUST_USER_QUIET_MS) return // the user is typing there: next tick
    const parent = a.parentId ? agents.get(a.parentId) : undefined
    const workerDir = real(a.cwd)
    const parentDir = parent ? real(parent.cwd) : null
    if (!workerDir || !parentDir || !parent) return
    if (!autoTrust({ ...a, cwd: workerDir }, { ...parent, cwd: parentDir })) return
    if (!isTrustDialogFor(lines, a.cwd) && !isTrustDialogFor(lines, workerDir)) return
    const keys = trustKeys(lines)
    if (!keys) return
    trustDone.add(a.id)
    trustSince.delete(a.id)
    audit.write({ tile: a.id, action: 'auto-trust', folder: workerDir, parent: a.parentId })
    keys.forEach((k, i) => setTimeout(() => agents.write(a.id, k, 'orchestrator'), i * TRUST_KEY_GAP_MS))
  }
  const handler = new McpHandler(agents, audit, {}, { home, captured })
  pipe = new McpPipe((orch, msg) => handler.handle(orch, msg))
  try {
    await pipe.listen()
  } catch (err) {
    console.error('organizer pipe unavailable; AI tiles run without clio tools', err)
    pipe = null
  }
  const activity = new AgentActivity()

  const send = (channel: string, value: unknown) => {
    if (!window.isDestroyed()) window.webContents.send(channel, value)
  }
  // Output is batched per tile per frame: node-pty can deliver thousands of small chunks.
  const pending = new Map<string, string>()
  let flushTimer: NodeJS.Timeout | null = null
  agents.on('data', (id, data) => {
    pending.set(id, (pending.get(id) ?? '') + data)
    flushTimer ??= setTimeout(() => {
      flushTimer = null
      for (const [pid, chunk] of pending) send('agent-data', { id: pid, data: chunk })
      pending.clear()
    }, FLUSH_MS)
  })
  agents.on('exit', (id) => pipe?.revoke(id))
  agents.on('changed', onChange)

  ipcMain.handle('agents:available', () => PROVIDERS.filter((p) => programs.get(p)))
  ipcMain.handle('agents:pick-folder', async () => {
    const r = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  // Quick-launch bar: a shell in a folder the user pasted (empty = home).
  ipcMain.handle('agents:start-shell', (_e, raw: { provider?: unknown; folder?: unknown }) => {
    const provider = raw?.provider === 'cmd' || raw?.provider === 'pwsh' ? raw.provider : null
    const typed = typeof raw?.folder === 'string' ? raw.folder : ''
    const cwd = typed.trim() ? normalizeFolder(typed, home) : home
    if (!provider) return { ok: false, error: 'bad-request' }
    if (!cwd) return { ok: false, error: 'bad-cwd', detail: typed }
    const r = agents.start({ provider, role: 'plain', cwd, task: '' }, null)
    return r.ok || r.error !== 'bad-cwd' ? r : { ...r, detail: cwd }
  })
  // The sandboxed page has no clipboard of its own: copy/paste in agent tiles goes through here.
  // Electron 44's clipboard is asynchronous (readText/writeText return promises).
  ipcMain.handle('clipboard:read', async () => parseClipboardText(await clipboard.readText()) ?? '')
  ipcMain.on('clipboard:write', (_e, raw) => {
    const text = parseClipboardText(raw)
    if (text !== null) void clipboard.writeText(text)
  })
  ipcMain.handle('agents:start', (_e, raw) => {
    const start = parseAgentStart(raw)
    return start ? agents.start(start, null) : { ok: false, error: 'bad-request' }
  })
  ipcMain.on('agents:input', (_e, raw: { id?: unknown; data?: unknown }) => {
    const id = parseAgentId(raw?.id)
    if (id && typeof raw.data === 'string' && raw.data.length <= MAX_INPUT) agents.write(id, raw.data, 'user')
  })
  ipcMain.on('agents:resize', (_e, raw: { id?: unknown }) => {
    const id = parseAgentId(raw?.id)
    const size = parseTerminalSize(raw)
    if (id && size) agents.resize(id, size.cols, size.rows)
  })
  ipcMain.on('agents:stop', (_e, raw) => {
    const id = parseAgentId(raw)
    if (id) agents.stop(id)
  })
  ipcMain.on('agents:remove', (_e, raw) => {
    const id = parseAgentId(raw)
    if (!id) return
    activity.forget(id)
    agents.remove(id)
  })
  ipcMain.on('agents:unlock', (_e, raw: { id?: unknown; unlocked?: unknown }) => {
    const id = parseAgentId(raw?.id)
    if (id && typeof raw.unlocked === 'boolean') agents.setUnlocked(id, raw.unlocked)
  })

  return {
    infos: () =>
      agents.list().map((a) => ({
        id: a.id,
        title: a.screen.title || a.provider,
        className: 'agent',
        processName: a.provider,
        alive: !a.exited,
        ...activity.info(a.id),
        agent: {
          provider: a.provider,
          role: a.role,
          parentId: a.parentId,
          cwd: a.cwd,
          exited: a.exited,
          unlocked: a.unlocked,
          // Claude's folder trust question defaults to "No, exit": the tile says so (the user decides).
          asksTrust: a.provider === 'claude' && !a.exited && detectTrustPrompt(a.screen.visibleLines())
        }
      })),
    tick: (attended) => {
      let changed = false
      const now = Date.now()
      for (const a of agents.list()) {
        if (a.exited) continue
        answerTrust(a)
        const before = JSON.stringify(activity.info(a.id))
        activity.tick(a.id, { now, screen: a.screen.hash(), title: a.screen.title }, attended.includes(a.id))
        if (JSON.stringify(activity.info(a.id)) !== before) changed = true
      }
      return changed
    },
    clearBadge: (id) => activity.clearBadge(id),
    running: () => agents.list().filter((a) => !a.exited).length,
    stopAll: () => agents.stopAll(),
    close: () => pipe?.close(),
    tail: (id, lines) => agents.get(id)?.screen.tail(lines) ?? '',
    start: (start) => agents.start(start, null),
    toolsDelivered: (id) => delivered.has(id),
    write: (id, text) => agents.write(id, text, 'user'),
    mcpEndpoint: (orch) => {
      const a = agents.get(orch)
      return pipe && a && hasOrganizerTools(a.provider, a.role) ? { pipe: pipe.name, token: pipe.issue(orch) } : null
    }
  }
}
