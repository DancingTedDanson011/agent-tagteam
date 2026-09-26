import { describe, expect, it } from 'vitest'
import { commandPath, conhostCommandLine, describeSession, wtArgs } from './recipe'

const CMD = 'C:\\Windows\\System32\\cmd.exe'
const CLAUDE = 'C:\\Users\\m\\AppData\\Roaming\\npm\\claude.cmd'

describe('wtArgs', () => {
  const none = { cmd: CMD, run: null }
  it('opens a NEW window (never a tab in one of yours) in the folder, with title and tab colour', () => {
    expect(wtArgs({ kind: 'window', host: 'wt', cwd: null }, 'C:\\work', { label: 'Build', color: 'blue' }, false, none)).toEqual([
      '-w', 'new', '-d', 'C:\\work', '--title', 'Build', '--tabColor', '#539bf5'
    ])
  })
  it('without a name or colour, no title or colour argument', () => {
    expect(wtArgs({ kind: 'window', host: 'wt', cwd: null }, 'C:\\work', {}, false, none)).toEqual(['-w', 'new', '-d', 'C:\\work'])
  })
  it('starts the agent CLI by its ABSOLUTE path inside a cmd that stays open, resumed when asked', () => {
    // cmd /k with a bare name searches the working folder first: a planted claude.cmd there would run
    // (cold review 2026-09-25, reproduced). So the program is resolved from PATH by the app.
    const run = { cmd: CMD, run: CLAUDE }
    expect(wtArgs({ kind: 'window', host: 'wt', cwd: null, run: 'claude' }, 'C:\\w', {}, true, run)).toEqual(['-w', 'new', '-d', 'C:\\w', CMD, '/k', CLAUDE, '--continue'])
    expect(wtArgs({ kind: 'window', host: 'wt', cwd: null, run: 'codex' }, 'C:\\w', {}, true, run)?.slice(4)).toEqual([CMD, '/k', CLAUDE, 'resume', '--last'])
    expect(wtArgs({ kind: 'window', host: 'wt', cwd: null, run: 'opencode' }, 'C:\\w', {}, false, run)?.slice(4)).toEqual([CMD, '/k', CLAUDE])
  })
  it('an agent CLI that could not be resolved safely is left out: the shell still opens', () => {
    expect(wtArgs({ kind: 'window', host: 'wt', cwd: null, run: 'claude' }, 'C:\\w', {}, true, none)).toEqual(['-w', 'new', '-d', 'C:\\w'])
  })
  it('refuses a folder or name that Windows Terminal would split at ";"', () => {
    expect(wtArgs({ kind: 'window', host: 'wt', cwd: null }, 'C:\\a;calc', {}, false, none)).toBeNull()
    expect(wtArgs({ kind: 'window', host: 'wt', cwd: null }, 'C:\\a', { label: 'x;calc' }, false, none)).toBeNull()
  })
})

describe('conhostCommandLine', () => {
  it('forces a classic console window through conhost.exe, with the shell by its absolute path', () => {
    expect(conhostCommandLine({ kind: 'window', host: 'conhost', shell: 'cmd', cwd: null }, false, { shell: CMD, run: null })).toBe(`conhost.exe ${CMD}`)
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    expect(conhostCommandLine({ kind: 'window', host: 'conhost', shell: 'powershell', cwd: null }, false, { shell: ps, run: null })).toBe(`conhost.exe ${ps} -NoLogo`)
  })
  it('quotes a shell path with spaces; the agent CLI runs by its absolute path', () => {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    expect(conhostCommandLine({ kind: 'window', host: 'conhost', shell: 'pwsh', cwd: null, run: 'claude' }, true, { shell: pwsh, run: CLAUDE })).toBe(
      `conhost.exe "${pwsh}" -NoLogo -NoExit -Command ${CLAUDE} --continue`
    )
    expect(conhostCommandLine({ kind: 'window', host: 'conhost', shell: 'cmd', cwd: null, run: 'codex' }, true, { shell: CMD, run: CLAUDE })).toBe(`conhost.exe ${CMD} /k ${CLAUDE} resume --last`)
  })
})

describe('commandPath', () => {
  const noShort = () => null
  it('keeps a plain absolute path', () => {
    expect(commandPath(CLAUDE, noShort)).toBe(CLAUDE)
  })
  it('a path cmd or PowerShell would split or interpret goes through its 8.3 short name, else it is refused', () => {
    const spaced = 'C:\\Users\\Max Muster\\AppData\\Roaming\\npm\\claude.cmd'
    expect(commandPath(spaced, () => 'C:\\Users\\MAXMUS~1\\AppData\\Roaming\\npm\\claude.cmd')).toBe('C:\\Users\\MAXMUS~1\\AppData\\Roaming\\npm\\claude.cmd')
    expect(commandPath(spaced, noShort)).toBeNull()
    expect(commandPath('C:\\a&calc\\claude.cmd', () => 'C:\\a&calc\\claude.cmd')).toBeNull()
    expect(commandPath('claude.cmd', noShort)).toBeNull()
    expect(commandPath(null, noShort)).toBeNull()
  })
})

describe('describeSession', () => {
  const noCwd = () => null
  it('an agent tile keeps program, role and folder; workers are left to their orchestrator', () => {
    const agent = { provider: 'codex' as const, role: 'orchestrator' as const, cwd: 'C:\\work' }
    expect(describeSession({ processName: 'codex', className: '', title: '', agent }, noCwd)).toEqual({ kind: 'agent', provider: 'codex', role: 'orchestrator', cwd: 'C:\\work' })
    expect(describeSession({ processName: 'codex', className: '', title: '', agent: { ...agent, role: 'worker' } }, noCwd)).toBeNull()
  })
  it("an agent tile's folder is stored the way the parser reads it back (cold review)", () => {
    const agent = { provider: 'cmd' as const, role: 'plain' as const, cwd: 'C:\\work\\' }
    expect(describeSession({ processName: 'cmd', className: '', title: '', agent }, noCwd)).toEqual({ kind: 'agent', provider: 'cmd', role: 'plain', cwd: 'C:\\work' })
  })
  it('a classic console window: its shell and the folder read from the process', () => {
    expect(describeSession({ processName: 'cmd.exe', className: 'ConsoleWindowClass', title: 'x' }, () => 'C:\\work\\')).toEqual({ kind: 'window', host: 'conhost', shell: 'cmd', cwd: 'C:\\work' })
    expect(describeSession({ processName: 'PowerShell.exe', className: 'ConsoleWindowClass', title: 'x' }, () => 'C:\\')).toEqual({ kind: 'window', host: 'conhost', shell: 'powershell', cwd: 'C:\\' })
  })
  it('an unreadable folder is unknown, not guessed', () => {
    expect(describeSession({ processName: 'pwsh.exe', className: 'ConsoleWindowClass', title: 'x' }, noCwd)).toEqual({ kind: 'window', host: 'conhost', shell: 'pwsh', cwd: null })
  })
  it('Windows Terminal: folder unknown (one process serves every window); Claude recognized by its title', () => {
    expect(describeSession({ processName: 'WindowsTerminal.exe', className: 'CASCADIA_HOSTING_WINDOW_CLASS', title: '✳ my-repo' }, () => 'C:\\never')).toEqual({ kind: 'window', host: 'wt', cwd: null, run: 'claude' })
    expect(describeSession({ processName: 'WindowsTerminal.exe', className: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'PowerShell' }, noCwd)).toEqual({ kind: 'window', host: 'wt', cwd: null })
  })
  it('anything else has no recipe', () => {
    expect(describeSession({ processName: 'mintty.exe', className: 'mintty', title: 'x' }, noCwd)).toBeNull()
  })
})
