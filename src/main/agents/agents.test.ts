import { describe, expect, it } from 'vitest'
import { AgentManager, type PtyLike, type SpawnPty } from './agents'
import { Screen } from './screen'

function fakePty() {
  const spawned: Array<{ file: string; args: string; cwd: string; env: Record<string, string> }> = []
  const ptys: Array<PtyLike & { emit(d: string): void; exit(): void; written: string[]; killed: boolean }> = []
  const spawn: SpawnPty = (file, args, opts) => {
    spawned.push({ file, args, cwd: opts.cwd, env: opts.env })
    let onData: (d: string) => void = () => undefined
    let onExit: (e: { exitCode: number }) => void = () => undefined
    const p = {
      pid: 100 + ptys.length,
      written: [] as string[],
      killed: false,
      onData: (cb: (d: string) => void) => ((onData = cb), { dispose: () => undefined }),
      onExit: (cb: (e: { exitCode: number }) => void) => ((onExit = cb), { dispose: () => undefined }),
      write(d: string) {
        this.written.push(d)
      },
      resize: () => undefined,
      kill() {
        this.killed = true
        onExit({ exitCode: 0 })
      },
      emit: (d: string) => onData(d),
      exit: () => onExit({ exitCode: 0 })
    }
    ptys.push(p)
    return p
  }
  return { spawn, spawned, ptys }
}

const deps = (f: ReturnType<typeof fakePty>, extra: Partial<ConstructorParameters<typeof AgentManager>[0]> = {}) => ({
  spawn: f.spawn,
  program: (p: string) => (p === 'codex' ? null : { file: `C:\\bin\\${p}.exe`, prefix: [] }),
  launch: () => ({ args: ['--x'], env: { A: '1' }, files: [] }),
  writeFile: () => undefined,
  removeFile: () => undefined,
  isDir: (d: string) => d === 'C:\\work',
  baseEnv: { PATH: 'p' },
  ...extra
})

describe('AgentManager', () => {
  it('starts a known program in an existing folder, with its launch args and environment', () => {
    const f = fakePty()
    const m = new AgentManager(deps(f))
    const r = m.start({ provider: 'claude', role: 'plain', cwd: 'C:\\work', task: '' }, null)
    expect(r).toEqual({ ok: true, id: 'a1' })
    expect(f.spawned[0]).toEqual({ file: 'C:\\bin\\claude.exe', args: '--x', cwd: 'C:\\work', env: { PATH: 'p', A: '1' } })
    expect(m.get('a1')?.parentId).toBeNull()
  })

  it('refuses a folder that does not exist and a program it cannot find', () => {
    const f = fakePty()
    const m = new AgentManager(deps(f))
    expect(m.start({ provider: 'claude', role: 'plain', cwd: 'C:\\nope', task: '' }, null)).toEqual({ ok: false, error: 'bad-cwd' })
    expect(m.start({ provider: 'codex', role: 'plain', cwd: 'C:\\work', task: '' }, null)).toEqual({ ok: false, error: 'not-installed' })
    expect(f.spawned).toEqual([])
  })

  it('output reaches the screen and listeners; input from the user is written and timestamped', () => {
    const f = fakePty()
    let now = 1000
    const m = new AgentManager(deps(f, { now: () => now }))
    const seen: string[] = []
    m.on('data', (id, d) => seen.push(`${id}:${d}`))
    m.start({ provider: 'cmd', role: 'plain', cwd: 'C:\\work', task: '' }, null)
    f.ptys[0].emit('hello\r\n')
    expect(seen).toEqual(['a1:hello\r\n'])
    now = 2000
    m.write('a1', 'dir\r', 'user')
    expect(f.ptys[0].written).toEqual(['dir\r'])
    expect(m.get('a1')?.lastUserInputAt).toBe(2000)
  })

  it('stop kills the process; an exited tile stays until it is closed', () => {
    const f = fakePty()
    const m = new AgentManager(deps(f))
    m.start({ provider: 'cmd', role: 'plain', cwd: 'C:\\work', task: '' }, null)
    m.stop('a1')
    expect(f.ptys[0].killed).toBe(true)
    expect(m.get('a1')?.exited).toBe(true)
    m.write('a1', 'x', 'user') // no throw, nothing written to a dead process
    expect(f.ptys[0].written).toEqual([])
    m.remove('a1')
    expect(m.get('a1')).toBeUndefined()
  })

  it('files of a start (an MCP config with a token) exist while the program runs, and go with it', () => {
    const f = fakePty()
    const files = new Map<string, string>()
    const m = new AgentManager(
      deps(f, {
        launch: () => ({ args: [], env: {}, files: [{ path: 'C:\\data\\mcp\\a1.json', content: '{"t":1}' }] }),
        writeFile: (p, c) => void files.set(p, c),
        removeFile: (p) => void files.delete(p)
      })
    )
    m.start({ provider: 'claude', role: 'orchestrator', cwd: 'C:\\work', task: '' }, null)
    expect([...files.keys()]).toEqual(['C:\\data\\mcp\\a1.json'])
    f.ptys[0].exit()
    expect(files.size).toBe(0)
  })

  it('a failed start says why (the program path and the system message)', () => {
    const f = fakePty()
    const m = new AgentManager(
      deps(f, {
        spawn: () => {
          throw new Error('File not found: C:\\npm\\node.exe')
        }
      })
    )
    expect(m.start({ provider: 'claude', role: 'plain', cwd: 'C:\\work', task: '' }, null)).toEqual({
      ok: false,
      error: 'spawn-failed',
      detail: 'C:\\bin\\claude.exe: File not found: C:\\npm\\node.exe'
    })
  })

  it('workers remember their orchestrator', () => {
    const f = fakePty()
    const m = new AgentManager(deps(f))
    m.start({ provider: 'claude', role: 'orchestrator', cwd: 'C:\\work', task: '' }, null)
    m.start({ provider: 'opencode', role: 'worker', cwd: 'C:\\work', task: 'T' }, 'a1')
    expect(m.get('a2')?.parentId).toBe('a1')
  })
})

describe('Screen (headless terminal)', () => {
  it('renders the visible screen and the tail, in buffer-absolute rows', async () => {
    const s = new Screen(20, 3)
    await s.write('one\r\ntwo\r\nthree\r\nfour')
    expect(s.visibleLines()).toEqual(['two', 'three', 'four'])
    expect(s.tail(10)).toBe('one\ntwo\nthree\nfour')
    expect(s.tail(2)).toBe('three\nfour')
  })
  it('the tail ends at the last written line, not at the empty rows below it', async () => {
    const s = new Screen(40, 30)
    await s.write('RESULT: done\r\n')
    expect(s.tail(5)).toBe('RESULT: done')
  })
  it('a spinner frame change does not change the masked hash; real text does', async () => {
    const s = new Screen(20, 3)
    await s.write('⠋ working')
    const a = s.hash()
    await s.write('\r⠙ working')
    expect(s.hash()).toBe(a)
    await s.write('\r\ndone')
    expect(s.hash()).not.toBe(a)
  })
})
