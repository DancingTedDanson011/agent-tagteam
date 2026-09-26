// Where the programs of the agent tiles live on this machine. Looked up once in PATH (like a shell
// would), then started directly — the npm .cmd shims are read, never executed.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProvider } from '../../shared/types'
import { resolveFromShim, type Program } from './providers'

type Fs = { exists: (p: string) => boolean; read: (p: string) => string }
const realFs: Fs = { exists: existsSync, read: (p) => readFileSync(p, 'utf8') }

/** First `name` in the PATH directories (absolute directories only: a relative one is the cwd). */
export function findOnPath(name: string, pathEnv: string, fs: Fs = realFs): string | null {
  for (const dir of pathEnv.split(';')) {
    if (!/^[a-zA-Z]:\\/.test(dir)) continue
    const p = join(dir, name)
    if (fs.exists(p)) return p
  }
  return null
}

export function resolveProgram(provider: AgentProvider, pathEnv: string, systemDir: string, fs: Fs = realFs): Program | null {
  if (provider === 'cmd') return { file: join(systemDir, 'cmd.exe'), prefix: [] }
  if (provider === 'pwsh') {
    const pwsh = findOnPath('pwsh.exe', pathEnv, fs)
    return { file: pwsh ?? join(systemDir, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), prefix: [] }
  }
  const exe = findOnPath(`${provider}.exe`, pathEnv, fs)
  if (exe) return { file: exe, prefix: [] }
  const shim = findOnPath(`${provider}.cmd`, pathEnv, fs)
  if (!shim) return null
  const node = findOnPath('node.exe', pathEnv, fs)
  return resolveFromShim(fs.read(shim), shim.slice(0, shim.lastIndexOf('\\')), node ?? 'node.exe')
}
