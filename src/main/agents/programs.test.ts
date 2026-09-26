import { describe, expect, it } from 'vitest'
import { findOnPath, resolveProgram } from './programs'

const files: Record<string, string> = {
  'C:\\npm\\claude.cmd': '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  'C:\\npm\\codex.cmd': '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  'C:\\node\\node.exe': '',
  'C:\\tools\\opencode.exe': '',
  'relative\\claude.cmd': 'evil'
}
const fs = { exists: (p: string) => p in files, read: (p: string) => files[p] }
const PATH = 'relative;C:\\tools;C:\\npm;C:\\node'
const SYS = 'C:\\Windows\\System32'

describe('programs', () => {
  it('searches absolute PATH directories only (a relative entry would be the current folder)', () => {
    expect(findOnPath('claude.cmd', PATH, fs)).toBe('C:\\npm\\claude.cmd')
    expect(findOnPath('missing.exe', PATH, fs)).toBeNull()
  })
  it('prefers a real exe, else reads the npm shim; codex runs with the node from PATH', () => {
    expect(resolveProgram('opencode', PATH, SYS, fs)).toEqual({ file: 'C:\\tools\\opencode.exe', prefix: [] })
    expect(resolveProgram('claude', PATH, SYS, fs)).toEqual({ file: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', prefix: [] })
    expect(resolveProgram('codex', PATH, SYS, fs)).toEqual({ file: 'C:\\node\\node.exe', prefix: ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'] })
  })
  it('shells come from the system folder; a missing agent is null', () => {
    expect(resolveProgram('cmd', PATH, SYS, fs)).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', prefix: [] })
    expect(resolveProgram('pwsh', PATH, SYS, fs)?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(resolveProgram('codex', 'C:\\tools', SYS, fs)).toBeNull()
  })
})
