import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentManager, type PtyLike, type SpawnPty } from './agents'
import { AuditLog, McpHandler, redact } from './mcp'

// Token-shaped test values are assembled at runtime so no credential-shaped literal sits in the repo.
const fake = (prefix: string, body: string) => [prefix, body].join('')

function setup() {
  const ptys: Array<PtyLike & { written: string[]; emit(d: string): void }> = []
  const spawn: SpawnPty = () => {
    let onData: (d: string) => void = () => undefined
    const p = {
      pid: 1,
      written: [] as string[],
      onData: (cb: (d: string) => void) => ((onData = cb), { dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
      write(d: string) {
        this.written.push(d)
      },
      resize: () => undefined,
      kill: () => undefined,
      emit: (d: string) => onData(d)
    }
    ptys.push(p)
    return p
  }
  const agents = new AgentManager({
    spawn,
    program: () => ({ file: 'x.exe', prefix: [] }),
    launch: () => ({ args: [], env: {}, files: [] }),
    writeFile: () => undefined,
    removeFile: () => undefined,
    isDir: (d) => d.startsWith('C:\\'),
    baseEnv: {}
  })
  const dir = mkdtempSync(join(tmpdir(), 'clio-mcp-'))
  const audit = new AuditLog(join(dir, 'agent-audit.log'), 400)
  const handler = new McpHandler(agents, audit, { userIdleMs: 0, pollMs: 5, enterDelayMs: 0 }, {
    home: 'C:\\Users\\marco',
    captured: () => [{ title: 'Windows PowerShell', program: 'WindowsTerminal.exe' }]
  })
  agents.start({ provider: 'claude', role: 'orchestrator', cwd: 'C:\\work', task: '' }, null) // a1
  agents.start({ provider: 'claude', role: 'plain', cwd: 'C:\\work', task: '' }, null) // a2: the user's own tile
  return { agents, handler, ptys, dir, audit }
}

const call = (h: McpHandler, orch: string, name: string, args: object = {}) =>
  h.handle(orch, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as Promise<{
    result: { content: Array<{ text: string }>; isError?: boolean }
  }>
const text = (r: Awaited<ReturnType<typeof call>>) => r.result.content[0].text

describe('MCP protocol', () => {
  it('initialize, tools/list, ping; notifications get no answer', async () => {
    const { handler } = setup()
    const init = (await handler.handle('a1', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as {
      result: { protocolVersion: string; capabilities: object; serverInfo: { name: string } }
    }
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(init.result.serverInfo.name).toBe('clio')
    const list = (await handler.handle('a1', { jsonrpc: '2.0', id: 2, method: 'tools/list' })) as { result: { tools: Array<{ name: string }> } }
    expect(list.result.tools.map((t) => t.name).sort()).toEqual(
      ['list_sessions', 'read_screen', 'read_tail', 'send', 'send_keys', 'spawn_worker', 'stop_worker', 'wait_for', 'wait_for_idle'].sort()
    )
    expect(await handler.handle('a1', { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await handler.handle('a1', { jsonrpc: '2.0', id: 3, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
    expect(await handler.handle('a1', { jsonrpc: '2.0', id: 4, method: 'nope' })).toMatchObject({ error: { code: -32601 } })
  })
})

describe('rights: an orchestrator controls only its own workers and tiles the user unlocked', () => {
  it("cannot read, type into or stop the user's own tile", async () => {
    const { handler, ptys } = setup()
    for (const [tool, args] of [
      ['read_screen', { id: 'a2' }],
      ['send', { id: 'a2', text: 'rm -rf /' }],
      ['stop_worker', { id: 'a2' }]
    ] as const) {
      const r = await call(handler, 'a1', tool, args)
      expect(r.result.isError, tool).toBe(true)
      expect(text(r), tool).toMatch(/not allowed/)
    }
    expect(ptys[1].written).toEqual([])
  })

  it('an unlocked tile can be read and typed into, but not stopped (the orchestrator did not start it)', async () => {
    const { handler, agents, ptys } = setup()
    agents.setUnlocked('a2', true)
    expect((await call(handler, 'a1', 'send', { id: 'a2', text: 'ls', enter: true })).result.isError).toBeFalsy()
    expect(ptys[1].written.join('')).toBe('ls\r')
    expect((await call(handler, 'a1', 'stop_worker', { id: 'a2' })).result.isError).toBe(true)
  })

  it('spawn_worker starts a worker owned by the caller; the caller then controls it fully', async () => {
    const { handler, agents, ptys } = setup()
    const r = await call(handler, 'a1', 'spawn_worker', { provider: 'codex', cwd: 'C:\\repo', task: 'fix it' })
    expect(JSON.parse(text(r))).toEqual({ id: 'a3' })
    expect(agents.get('a3')).toMatchObject({ role: 'worker', parentId: 'a1', provider: 'codex', cwd: 'C:\\repo' })
    ptys[2].emit('RESULT: done\r\n')
    await new Promise((res) => setTimeout(res, 20))
    expect(text(await call(handler, 'a1', 'read_tail', { id: 'a3', lines: 5 }))).toContain('RESULT: done')
    expect((await call(handler, 'a1', 'stop_worker', { id: 'a3' })).result.isError).toBeFalsy()
    expect(agents.get('a3')?.exited).toBe(true)
  })

  it('spawn_worker refuses unknown programs, orchestrator roles and missing folders', async () => {
    const { handler, agents } = setup()
    expect((await call(handler, 'a1', 'spawn_worker', { provider: 'bash' })).result.isError).toBe(true)
    expect((await call(handler, 'a1', 'spawn_worker', { provider: 'claude', cwd: 'relative' })).result.isError).toBe(true)
    expect((await call(handler, 'a1', 'spawn_worker', { provider: 'claude', task: '--dangerously-skip-permissions' })).result.isError, 'task as a flag').toBe(true)
    expect(agents.list()).toHaveLength(2)
  })

  it('an orchestrator cannot target itself, nor a worker of another orchestrator', async () => {
    const { handler, agents, ptys } = setup()
    agents.start({ provider: 'claude', role: 'orchestrator', cwd: 'C:\\work', task: '' }, null) // a3
    const other = JSON.parse(text(await call(handler, 'a3', 'spawn_worker', { provider: 'cmd' }))).id // a4
    for (const target of ['a1', other]) {
      const r = await call(handler, 'a1', 'send', { id: target, text: 'x' })
      expect(r.result.isError, target).toBe(true)
      expect((await call(handler, 'a1', 'stop_worker', { id: target })).result.isError, target).toBe(true)
    }
    expect(ptys[0].written).toEqual([])
    expect(ptys[3].written).toEqual([])
  })

  it('a plain AI tile has the tools too: it starts its own worker as a visible tile (Marco, 2026-09-25)', async () => {
    const { handler, agents } = setup()
    const r = await call(handler, 'a2', 'spawn_worker', { provider: 'codex', cwd: 'C:\\repo', task: 'hi' })
    expect(r.result.isError).toBeFalsy()
    expect(agents.get(JSON.parse(text(r)).id)).toMatchObject({ role: 'worker', parentId: 'a2' })
    // and it still cannot touch the orchestrator's tile
    expect((await call(handler, 'a2', 'read_screen', { id: 'a1' })).result.isError).toBe(true)
  })

  it('an unlocked tile is open to every AI tile with tools, not only an orchestrator (what the unlock button says)', async () => {
    const { handler, agents, ptys } = setup()
    agents.start({ provider: 'pwsh', role: 'plain', cwd: 'C:\\work', task: '' }, null) // a3: a shell tile
    expect((await call(handler, 'a2', 'send', { id: 'a3', text: 'x' })).result.isError).toBe(true)
    agents.setUnlocked('a3', true)
    expect((await call(handler, 'a2', 'send', { id: 'a3', text: 'x', enter: false })).result.isError).toBeFalsy()
    expect(ptys[2].written.join('')).toBe('x')
  })

  it('the tool descriptions carry the rules every client reads without a first message (cold review)', async () => {
    const { handler } = setup()
    const list = (await handler.handle('a2', { jsonrpc: '2.0', id: 2, method: 'tools/list' })) as { result: { tools: Array<{ name: string; description: string }> } }
    const d = Object.fromEntries(list.result.tools.map((t) => [t.name, t.description]))
    expect(d.list_sessions).toMatch(/what you can do/)
    expect(d.spawn_worker).toMatch(/visible tile/)
    expect(d.spawn_worker).toMatch(/never .*shell/i)
  })

  it('workers and shell tiles get no tools (no chain of agents starting agents)', async () => {
    const { handler, agents } = setup()
    const worker = JSON.parse(text(await call(handler, 'a1', 'spawn_worker', { provider: 'claude' }))).id
    agents.start({ provider: 'pwsh', role: 'plain', cwd: 'C:\\work', task: '' }, null)
    const shell = agents.list()[agents.list().length - 1].id
    for (const id of [worker, shell]) {
      const r = await call(handler, id, 'list_sessions')
      expect(r.result.isError, id).toBe(true)
    }
  })

  it('an orchestrator runs at most 8 workers at a time', async () => {
    const { handler } = setup()
    const ids: string[] = []
    for (let i = 0; i < 8; i++) ids.push(JSON.parse(text(await call(handler, 'a1', 'spawn_worker', { provider: 'cmd' }))).id)
    const ninth = await call(handler, 'a1', 'spawn_worker', { provider: 'cmd' })
    expect(ninth.result.isError).toBe(true)
    expect(text(ninth)).toMatch(/at most 8/)
    await call(handler, 'a1', 'stop_worker', { id: ids[0] })
    expect((await call(handler, 'a1', 'spawn_worker', { provider: 'cmd' })).result.isError, 'room again after one stopped').toBeFalsy()
  })

  it('an unknown caller is refused', async () => {
    const { handler } = setup()
    expect((await call(handler, 'a99', 'list_sessions')).result.isError).toBe(true)
  })

  it('list_sessions shows every tile with what the caller may do, and captured windows by name only', async () => {
    const { handler, agents } = setup()
    await call(handler, 'a1', 'spawn_worker', { provider: 'cmd' })
    type Listed = { tiles: Array<{ id: string; controllable: boolean; how?: string }>; windows: Array<{ title: string; how: string }> }
    const list = (): Promise<Listed> => call(handler, 'a1', 'list_sessions').then((r) => JSON.parse(text(r)))
    let l = await list()
    expect(l.tiles.map((t) => [t.id, t.controllable])).toEqual([
      ['a2', false],
      ['a3', true]
    ])
    expect(l.tiles[0].how).toMatch(/Für KI-Kacheln freigeben/)
    expect(l.windows).toEqual([{ title: 'Windows PowerShell', program: 'WindowsTerminal.exe', how: expect.stringMatching(/captured window/) }])
    agents.setUnlocked('a2', true)
    l = await list()
    expect(l.tiles.map((t) => t.controllable)).toEqual([true, true])
  })

  it('spawn_worker takes folders the way people write them', async () => {
    const { handler, agents } = setup()
    const r = await call(handler, 'a1', 'spawn_worker', { provider: 'cmd', cwd: '"C:/work/repo/"' })
    expect(r.result.isError).toBeFalsy()
    expect(agents.get('a3')?.cwd).toBe('C:\\work\\repo')
    const bad = await call(handler, 'a1', 'spawn_worker', { provider: 'cmd', cwd: 'repo' })
    expect(text(bad)).toMatch(/absolute folder/)
  })
})

describe('waiting and keys', () => {
  it('wait_for finds a substring; wait_for_idle times out while output keeps coming', async () => {
    const { handler, ptys } = setup()
    await call(handler, 'a1', 'spawn_worker', { provider: 'cmd' })
    setTimeout(() => ptys[2].emit('build ok\r\n'), 10)
    expect(JSON.parse(text(await call(handler, 'a1', 'wait_for', { id: 'a3', pattern: 'build ok', timeout_s: 2 })))).toMatchObject({ matched: true })
    const iv = setInterval(() => ptys[2].emit(`x${Math.random()}\r\n`), 5)
    const r = JSON.parse(text(await call(handler, 'a1', 'wait_for_idle', { id: 'a3', timeout_s: 0.2 })))
    clearInterval(iv)
    expect(r.idle).toBe(false)
  })

  it('send_keys maps named keys and rejects unknown ones', async () => {
    const { handler, ptys } = setup()
    await call(handler, 'a1', 'spawn_worker', { provider: 'cmd' })
    await call(handler, 'a1', 'send_keys', { id: 'a3', keys: ['up', 'enter', 'ctrl-c'] })
    expect(ptys[2].written.join('')).toBe('\x1b[A\r\x03')
    expect((await call(handler, 'a1', 'send_keys', { id: 'a3', keys: ['rm'] })).result.isError).toBe(true)
  })
})

describe('audit', () => {
  it('every write is logged with secrets masked, and the file rotates', async () => {
    const { handler, dir } = setup()
    await call(handler, 'a1', 'spawn_worker', { provider: 'cmd' })
    for (let i = 0; i < 6; i++) await call(handler, 'a1', 'send', { id: 'a3', text: `echo ${fake('sk-', 'proj-QQQQWWWWEEEERRRRTTTT')}${i}` })
    const log = readFileSync(join(dir, 'agent-audit.log'), 'utf8')
    expect(log).not.toContain('QQQQWWWW')
    expect(log).toContain('"tool":"send"')
    expect(existsSync(join(dir, 'agent-audit.log.1')), 'rotated at the size cap').toBe(true)
    expect(statSync(join(dir, 'agent-audit.log')).size).toBeLessThanOrEqual(400)
  })
  it('redact masks common token shapes', () => {
    const input = `key ${fake('sk-', 'proj-abcdefghijklmnop')} and ${fake('ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')} ${fake('Bearer ', 'abc.def.ghi')}`
    expect(redact(input)).not.toMatch(/abcdefghijklmnop|ABCDEFGHIJKLMNOP|abc\.def/)
  })
})
