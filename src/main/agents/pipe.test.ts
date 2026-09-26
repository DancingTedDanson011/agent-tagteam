// The real path an agent uses: node runs resources/clio-mcp.cjs, which talks to McpPipe.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpPipe } from './pipe'

const SHIM = resolve(__dirname, '../../../resources/clio-mcp.cjs')
let pipe: McpPipe | null = null
afterEach(() => pipe?.close())

type Run = { out: object[]; code: number | null; stderr: string }

/** Starts the shim, writes `lines`, and ends stdin after `holdMs` (or never, when holdMs is null). */
function runShim(pipeName: string, token: string | undefined, lines: object[], holdMs: number | null = 300): { done: Promise<Run>; end(): void } {
  const env = { ...process.env }
  delete env.CLIO_TOKEN
  if (token !== undefined) env.CLIO_TOKEN = token
  const p = spawn(process.execPath, [SHIM, '--pipe', pipeName], { stdio: ['pipe', 'pipe', 'pipe'], env })
  let out = ''
  let stderr = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (stderr += d))
  for (const l of lines) p.stdin.write(JSON.stringify(l) + '\n')
  if (holdMs !== null) setTimeout(() => p.stdin.end(), holdMs)
  const done = new Promise<Run>((res) =>
    p.on('exit', (code) =>
      res({
        out: out
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
        code,
        stderr
      })
    )
  )
  return { done, end: () => p.stdin.end() }
}

const echoPipe = async (seen: Array<[string, object]>) => {
  pipe = new McpPipe(async (orch, msg) => {
    seen.push([orch, msg])
    return { jsonrpc: '2.0', id: (msg as { id: number }).id, result: { orch } }
  })
  await pipe.listen()
  return pipe
}

describe('McpPipe + shim', () => {
  it('a valid token (from the environment) reaches the handler as that orchestrator; replies come back', async () => {
    const seen: Array<[string, object]> = []
    const p = await echoPipe(seen)
    const r = await runShim(p.name, p.issue('a1'), [{ jsonrpc: '2.0', id: 7, method: 'ping' }]).done
    expect(seen).toEqual([['a1', { jsonrpc: '2.0', id: 7, method: 'ping' }]])
    expect(r.out).toEqual([{ jsonrpc: '2.0', id: 7, result: { orch: 'a1' } }])
    expect(r.code).toBe(0)
  }, 15000)

  it('a wrong or revoked token is cut off before anything reaches the handler; a fresh one works (control)', async () => {
    const seen: Array<[string, object]> = []
    const p = await echoPipe(seen)
    const revoked = p.issue('a1')
    p.revoke('a1')
    const r1 = await runShim(p.name, revoked, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]).done
    const r2 = await runShim(p.name, 'nope', [{ jsonrpc: '2.0', id: 1, method: 'ping' }]).done
    // The server answers "unauthorized" and closes: the connection arrived and was refused (an
    // unreachable pipe would give no line at all).
    const refusal = [{ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }]
    expect([r1.out, r2.out]).toEqual([refusal, refusal])
    expect(seen).toEqual([])
    const ok = await runShim(p.name, p.issue('a1'), [{ jsonrpc: '2.0', id: 2, method: 'ping' }]).done
    expect(ok.out).toHaveLength(1)
  }, 20000)

  it('one live connection per token: a second process with the same token is refused', async () => {
    const seen: Array<[string, object]> = []
    const p = await echoPipe(seen)
    const token = p.issue('a1')
    const first = runShim(p.name, token, [{ jsonrpc: '2.0', id: 1, method: 'ping' }], null)
    await new Promise((r) => setTimeout(r, 500))
    const second = await runShim(p.name, token, [{ jsonrpc: '2.0', id: 2, method: 'ping' }]).done
    first.end()
    const firstRun = await first.done
    expect(firstRun.out).toHaveLength(1)
    expect(second.out).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'token already in use' } }])
    expect(seen.map(([, m]) => (m as { id: number }).id)).toEqual([1])
  }, 20000)

  it('the shim refuses to start without a pipe name or a token', async () => {
    expect((await runShim('C:\\not-a-pipe', 'x', []).done).code).toBe(2)
    expect((await runShim('\\\\.\\pipe\\x', undefined, []).done).code).toBe(2)
  }, 15000)
})
