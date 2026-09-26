// The local pipe the MCP shim connects to. A connection counts only after its first line carries a
// token this app issued for an orchestrator tile; everything after that is JSON-RPC, one per line.
import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'

const MAX_LINE = 1024 * 1024

export type RpcHandler = (orchestrator: string, msg: object) => Promise<object | null>

export class McpPipe {
  readonly name = `\\\\.\\pipe\\clio-${process.pid}-${randomBytes(8).toString('hex')}`
  private readonly tokens = new Map<string, string>()
  /** Tokens with a live connection: a second process presenting the same token is refused. */
  private readonly inUse = new Set<string>()
  private readonly server: Server

  constructor(private readonly handler: RpcHandler) {
    this.server = createServer((sock) => this.serve(sock))
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.name, () => resolve())
    })
  }

  /** A fresh secret for one orchestrator tile (passed to its shim on the command line). */
  issue(orchestrator: string): string {
    const token = randomBytes(24).toString('hex')
    this.tokens.set(token, orchestrator)
    return token
  }

  revoke(orchestrator: string): void {
    for (const [t, o] of this.tokens) if (o === orchestrator) this.tokens.delete(t)
  }

  close(): void {
    this.server.close()
  }

  private serve(sock: Socket): void {
    let orch: string | null = null
    let held: string | null = null
    let buf = ''
    const refuse = (message: string) => sock.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }) + '\n')
    sock.setEncoding('utf8')
    sock.on('error', () => sock.destroy())
    sock.on('close', () => {
      if (held) this.inUse.delete(held)
    })
    sock.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > MAX_LINE && !buf.includes('\n')) return sock.destroy()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: unknown
        try {
          msg = JSON.parse(line)
        } catch {
          if (orch === null) return sock.destroy()
          sock.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n')
          continue
        }
        if (orch === null) {
          const token = (msg as { token?: unknown })?.token
          const owner = typeof token === 'string' ? (this.tokens.get(token) ?? null) : null
          if (owner === null || typeof token !== 'string') return refuse('unauthorized')
          if (this.inUse.has(token)) return refuse('token already in use')
          this.inUse.add(token)
          held = token
          orch = owner
          continue
        }
        const from = orch
        void this.handler(from, msg as object).then(
          (reply) => {
            if (reply && !sock.destroyed) sock.write(JSON.stringify(reply) + '\n')
          },
          (err) => console.error('mcp handler failed', err)
        )
      }
    })
  }
}
