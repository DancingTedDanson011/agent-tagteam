// The MCP server every AI tile the user started talks to (orchestrator or plain; see
// hasOrganizerTools), through resources/clio-mcp.cjs and a local pipe. Rights are enforced here, not
// in the prompt: a tile reads and types only into its own workers and into tiles the user unlocked
// (for all AI tiles), and stops only its own workers. Every write is
// audited with secrets masked. Idle and input rules follow Marco's bridge (wait-for.ts, inject.ts).
import { appendFileSync, renameSync, statSync } from 'node:fs'
import type { AgentProvider } from '../../shared/types'
import { normalizeFolder } from '../../shared/folder'
import { startsLikeFlag } from '../../shared/validate'
import { parseTitleHint } from '../activity/activity'
import type { AgentManager, AgentSession } from './agents'
import { hasOrganizerTools } from './providers'

const PROTOCOL = '2025-06-18'
const MAX_WORKERS = 8
const WORKER_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'opencode', 'cmd', 'pwsh']

// ---------- secrets and audit ----------

const SECRETS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g, // OpenAI / Anthropic style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi
]

export function redact(text: string): string {
  return SECRETS.reduce((t, re) => t.replace(re, '****'), text)
}

/** Append-only JSON lines, rotated at `maxBytes` (bridge's MCP log grew to 244.5 MB without it). */
export class AuditLog {
  constructor(
    private readonly file: string,
    private readonly maxBytes = 1024 * 1024
  ) {}

  write(entry: Record<string, unknown>): void {
    const line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n'
    try {
      let size = 0
      try {
        size = statSync(this.file).size
      } catch {
        // first entry
      }
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) renameSync(this.file, this.file + '.1')
      appendFileSync(this.file, line)
    } catch (err) {
      console.error('audit log not writable', err)
    }
  }
}

// ---------- tools ----------

const KEYS: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-l': '\x0c',
  backspace: '\x7f',
  delete: '\x1b[3~',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  y: 'y',
  n: 'n'
}

const id = { type: 'string', description: 'Tile id from list_sessions, e.g. "a3".' }
const TOOLS = [
  {
    name: 'list_sessions',
    description:
      'All tiles of CLI Organizer (controllable ones: your workers and tiles the user unlocked) and captured windows by name. Call this first when the user asks what you can do here.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'spawn_worker',
    description:
      'Open another agent (Claude Code, Codex, OpenCode) or a shell as a visible tile next to you; returns its id. Use this whenever the user wants another agent opened or asked — never start agents through a shell (e.g. `codex exec`) or another MCP server. Then send, wait_for_idle, read_tail. The worker gets a short worker prompt; `task` is its first message. A new Claude worker may ask "Trust this folder?": in your own folder (or below) the organizer answers it; elsewhere ask the user, never confirm it yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: [...WORKER_PROVIDERS] },
        cwd: { type: 'string', description: 'Folder to start in, as the user names it (absolute; quotes, / and ~ are fine). Default: your own folder.' },
        task: { type: 'string' }
      },
      required: ['provider']
    }
  },
  {
    name: 'send',
    description: 'Type text into a tile, then Enter (unless enter=false). Waits until the user has stopped typing there.',
    inputSchema: { type: 'object', properties: { id, text: { type: 'string' }, enter: { type: 'boolean' } }, required: ['id', 'text'] }
  },
  {
    name: 'send_keys',
    description: `Press named keys: ${Object.keys(KEYS).join(', ')}.`,
    inputSchema: { type: 'object', properties: { id, keys: { type: 'array', items: { type: 'string' } } }, required: ['id', 'keys'] }
  },
  { name: 'read_screen', description: 'The visible screen of a tile.', inputSchema: { type: 'object', properties: { id }, required: ['id'] } },
  {
    name: 'read_tail',
    description: 'The last lines (scrollback + screen) of a tile.',
    inputSchema: { type: 'object', properties: { id, lines: { type: 'number', description: 'Default 80, max 2000.' } }, required: ['id'] }
  },
  {
    name: 'wait_for_idle',
    description: 'Wait until the tile has stopped working (quiet screen, or Claude shows ✳). Returns {idle, seconds}.',
    inputSchema: { type: 'object', properties: { id, timeout_s: { type: 'number', description: 'Default 120, max 1800.' } }, required: ['id'] }
  },
  {
    name: 'wait_for',
    description: 'Wait until text appears in the last 200 lines. Returns {matched, line, seconds}.',
    inputSchema: { type: 'object', properties: { id, pattern: { type: 'string' }, timeout_s: { type: 'number' } }, required: ['id', 'pattern'] }
  },
  { name: 'stop_worker', description: 'End one of YOUR workers.', inputSchema: { type: 'object', properties: { id }, required: ['id'] } }
]

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

class ToolError extends Error {}

/** What the orchestrator may know beyond the tiles: the user's home (for "~") and captured windows by name. */
export type McpWorld = { home: string; captured: () => Array<{ title: string; program: string }> }

export type McpTiming = { userIdleMs: number; pollMs: number; enterDelayMs: number; userIdleCapMs?: number }
const DEFAULT_TIMING: McpTiming = { userIdleMs: 1500, pollMs: 250, enterDelayMs: 60, userIdleCapMs: 10_000 }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const num = (v: unknown, def: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def)
const str = (v: unknown, name: string, max: number): string => {
  if (typeof v !== 'string' || v.length > max) throw new ToolError(`${name} must be a string of at most ${max} characters`)
  return v
}

export class McpHandler {
  private readonly timing: McpTiming

  constructor(
    private readonly agents: AgentManager,
    private readonly audit: AuditLog,
    timing: Partial<McpTiming> = {},
    private readonly world: McpWorld = { home: 'C:\\', captured: () => [] }
  ) {
    this.timing = { ...DEFAULT_TIMING, ...timing }
  }

  /** One JSON-RPC message from orchestrator `orch`. Null for notifications (no answer). */
  async handle(orch: string, msg: Rpc): Promise<object | null> {
    const reply = (result: object) => ({ jsonrpc: '2.0', id: msg.id ?? null, result })
    if (msg.id === undefined || msg.id === null) return null
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'clio', version: '1' }
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: TOOLS })
      case 'tools/call':
        return reply(await this.call(orch, String(msg.params?.name ?? ''), (msg.params?.arguments ?? {}) as Record<string, unknown>))
      default:
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${String(msg.method)}` } }
    }
  }

  private async call(orch: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
    try {
      const self = this.agents.get(orch)
      if (!self || !hasOrganizerTools(self.provider, self.role) || self.exited) throw new ToolError('only an AI tile the user started may use these tools')
      switch (name) {
        case 'list_sessions':
          // Everything, marked: an empty list left the orchestrator unable to tell the user what to do.
          return ok({
            tiles: this.agents
              .list()
              .filter((a) => a.id !== orch)
              .map((a) => this.describe(orch, a)),
            windows: this.world.captured().map((w) => ({
              ...w,
              how: 'captured window: not controllable; ask the user to start it as a tile (spawn_worker in its folder)'
            }))
          })
        case 'spawn_worker':
          return ok(this.spawn(self, args))
        case 'send':
          return ok(await this.send(orch, args))
        case 'send_keys': {
          const a = this.target(orch, args.id)
          if (!Array.isArray(args.keys) || args.keys.length === 0 || args.keys.length > 50) throw new ToolError('keys must be a list of 1 to 50 names')
          const bytes = args.keys.map((k) => {
            if (typeof k !== 'string' || !(k in KEYS)) throw new ToolError(`unknown key ${JSON.stringify(k)}`)
            return KEYS[k]
          })
          this.write(orch, a, bytes.join(''), 'send_keys', args.keys.join(' '))
          return ok({ sent: args.keys.length })
        }
        case 'read_screen':
          return ok(this.target(orch, args.id).screen.visibleLines().join('\n'))
        case 'read_tail':
          return ok(this.target(orch, args.id).screen.tail(num(args.lines, 80, 1, 2000)))
        case 'wait_for_idle':
          return ok(await this.waitIdle(this.target(orch, args.id), num(args.timeout_s, 120, 0, 1800) * 1000))
        case 'wait_for':
          return ok(await this.waitFor(this.target(orch, args.id), str(args.pattern, 'pattern', 500), num(args.timeout_s, 120, 0, 1800) * 1000))
        case 'stop_worker': {
          const a = this.target(orch, args.id)
          if (a.parentId !== orch) throw new ToolError('not allowed: you can only stop workers you started')
          this.agents.stop(a.id)
          this.audit.write({ orch, tool: 'stop_worker', target: a.id })
          return ok({ stopped: a.id })
        }
        default:
          throw new ToolError(`unknown tool ${name}`)
      }
    } catch (err) {
      if (!(err instanceof ToolError)) console.error('mcp tool failed', err)
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
    }
  }

  private mayControl(orch: string, a: AgentSession): boolean {
    return a.id !== orch && (a.parentId === orch || a.unlocked)
  }

  private target(orch: string, raw: unknown): AgentSession {
    const a = typeof raw === 'string' ? this.agents.get(raw) : undefined
    if (!a || !this.mayControl(orch, a)) throw new ToolError(`not allowed: ${JSON.stringify(raw)} is not one of your workers or an unlocked tile`)
    return a
  }

  private describe(orch: string, a: AgentSession) {
    const controllable = this.mayControl(orch, a)
    return {
      id: a.id,
      provider: a.provider,
      role: a.role,
      cwd: a.cwd,
      title: a.screen.title,
      exited: a.exited,
      yours: a.parentId === orch,
      controllable,
      ...(controllable ? {} : { how: 'not yours: the user can click "Für KI-Kacheln freigeben" (unlock) on this tile' })
    }
  }

  private spawn(self: AgentSession, args: Record<string, unknown>) {
    const provider = WORKER_PROVIDERS.find((p) => p === args.provider)
    if (!provider) throw new ToolError(`provider must be one of ${WORKER_PROVIDERS.join(', ')}`)
    const cwd = args.cwd === undefined ? self.cwd : normalizeFolder(str(args.cwd, 'cwd', 1024), this.world.home)
    if (!cwd) throw new ToolError('cwd must be an absolute folder, e.g. C:\\Users\\name\\project (quotes, / and ~ are fine)')
    const task = args.task === undefined ? '' : str(args.task, 'task', 8000)
    if (startsLikeFlag(task)) throw new ToolError('task must not start with "-"')
    // A looping model must not fill the machine with processes (cold review).
    const running = this.agents.list().filter((a) => a.parentId === self.id && !a.exited).length
    if (running >= MAX_WORKERS) throw new ToolError(`at most ${MAX_WORKERS} workers at a time; stop one first`)
    const r = this.agents.start({ provider, role: 'worker', cwd, task }, self.id)
    this.audit.write({ orch: self.id, tool: 'spawn_worker', provider, cwd, task: redact(task).slice(0, 200), result: r })
    if (!r.ok) {
      const why = 'detail' in r ? r.detail : r.error === 'bad-cwd' ? `folder does not exist: ${cwd}` : `${provider} is not installed`
      throw new ToolError(`could not start ${provider}: ${why}`)
    }
    return { id: r.id }
  }

  private async send(orch: string, args: Record<string, unknown>) {
    const a = this.target(orch, args.id)
    const text = str(args.text, 'text', 64 * 1024)
    // Do not type into what the user is typing right now (bridge inject.ts); give up after the cap.
    const cap = Date.now() + (this.timing.userIdleCapMs ?? 10_000)
    while (Date.now() - a.lastUserInputAt < this.timing.userIdleMs) {
      if (Date.now() > cap) throw new ToolError('the user is typing in this tile; try again shortly')
      await sleep(this.timing.pollMs)
    }
    // Multi-line text into an AI tile goes in as one paste, so Enter does not fire line by line.
    const paste = text.includes('\n') && a.provider !== 'cmd' && a.provider !== 'pwsh'
    this.write(orch, a, paste ? `\x1b[200~${text}\x1b[201~` : text, 'send', text)
    if (args.enter !== false) {
      await sleep(this.timing.enterDelayMs)
      this.write(orch, a, '\r', 'send', '<enter>', false)
    }
    return { sent: text.length, enter: args.enter !== false }
  }

  private write(orch: string, a: AgentSession, data: string, tool: string, shown: string, log = true): void {
    if (!this.agents.write(a.id, data, 'orchestrator')) throw new ToolError(`${a.id} has exited`)
    if (log) this.audit.write({ orch, tool, target: a.id, bytes: data.length, text: redact(shown).slice(0, 200) })
  }

  /** Idle: no output for userIdleMs AND the (spinner-masked) screen unchanged over three checks. */
  private async waitIdle(a: AgentSession, timeoutMs: number) {
    const start = Date.now()
    let last = ''
    let stable = 0
    for (;;) {
      if (a.exited) return { idle: true, exited: true, seconds: (Date.now() - start) / 1000 }
      if (parseTitleHint(a.screen.title) === 'idle' && Date.now() - a.lastOutputAt >= this.timing.userIdleMs) {
        return { idle: true, seconds: (Date.now() - start) / 1000 }
      }
      if (Date.now() - a.lastOutputAt >= this.timing.userIdleMs) {
        const h = a.screen.hash()
        stable = h === last ? stable + 1 : 0
        last = h
        if (stable >= 2) return { idle: true, seconds: (Date.now() - start) / 1000 }
      } else stable = 0
      if (Date.now() - start >= timeoutMs) return { idle: false, seconds: (Date.now() - start) / 1000 }
      await sleep(this.timing.pollMs)
    }
  }

  private async waitFor(a: AgentSession, pattern: string, timeoutMs: number) {
    const start = Date.now()
    for (;;) {
      const line = a.screen.tail(200).split('\n').find((l) => l.includes(pattern))
      if (line !== undefined) return { matched: true, line, seconds: (Date.now() - start) / 1000 }
      if (a.exited || Date.now() - start >= timeoutMs) return { matched: false, seconds: (Date.now() - start) / 1000 }
      await sleep(this.timing.pollMs)
    }
  }
}
