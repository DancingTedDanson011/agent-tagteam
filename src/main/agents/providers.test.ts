import { describe, expect, it } from 'vitest'
import { buildLaunch, hasOrganizerTools, resolveFromShim, type McpLink } from './providers'

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm'
// Real shim bodies from this machine (claude.cmd / codex.cmd), shortened to the relevant line.
const CLAUDE_SHIM = 'CALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
const CODEX_SHIM = 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'

describe('resolveFromShim', () => {
  it('finds a native exe behind an npm shim', () => {
    expect(resolveFromShim(CLAUDE_SHIM, NPM, 'C:\\node\\node.exe')).toEqual({
      file: `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
      prefix: []
    })
  })
  it('runs a JS entry with node, never through cmd.exe', () => {
    expect(resolveFromShim(CODEX_SHIM, NPM, 'C:\\node\\node.exe')).toEqual({
      file: 'C:\\node\\node.exe',
      prefix: [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`]
    })
  })
  it('the COMPLETE real codex.cmd: the executed target, not the IF EXIST node.exe probe above it', () => {
    // Byte-for-byte from this machine (2026-09-24). The first %dp0% path in it is the node.exe
    // existence check; taking that one started npm\node.exe and failed with "File not found".
    const full = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
      ''
    ].join('\r\n')
    expect(resolveFromShim(full, NPM, 'C:\\node\\node.exe')).toEqual({
      file: 'C:\\node\\node.exe',
      prefix: [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`]
    })
  })

  it('refuses a shim without a recognizable target, or one pointing outside the npm folder', () => {
    expect(resolveFromShim('@echo off\r\nsomething %*', NPM, 'node')).toBeNull()
    expect(resolveFromShim('"%dp0%\\..\\..\\evil.exe" %*', NPM, 'node')).toBeNull()
  })
})

const TOKEN = 'tok123secret'
const mcp: McpLink = { node: 'C:\\node\\node.exe', shim: 'C:\\app\\clio-mcp.cjs', pipe: '\\\\.\\pipe\\clio-1', token: TOKEN, configFile: 'C:\\data\\mcp\\a1.json' }
const prompts = { orchestrator: 'ORCH-PROMPT', worker: 'WORKER-PROMPT', agent: 'AGENT-PROMPT' }
const shimCommand = [mcp.shim, '--pipe', mcp.pipe]

describe('buildLaunch', () => {
  it('the MCP token never appears on any command line (cold review: same-user processes read them)', () => {
    for (const provider of ['claude', 'codex', 'opencode'] as const) {
      const l = buildLaunch({ provider, role: 'orchestrator', task: 'T', prompts, mcp })
      expect(l.args.join(' '), provider).not.toContain(TOKEN)
    }
  })

  it('claude as orchestrator: prompt appended, MCP from a config file whose server gets the token by env', () => {
    const l = buildLaunch({ provider: 'claude', role: 'orchestrator', task: 'Fix the tests', prompts, mcp })
    expect(l.args).toEqual(['--append-system-prompt', 'ORCH-PROMPT', '--mcp-config', mcp.configFile, 'Fix the tests'])
    expect(l.files).toHaveLength(1)
    expect(l.files[0].path).toBe(mcp.configFile)
    expect(JSON.parse(l.files[0].content).mcpServers.clio).toEqual({ command: mcp.node, args: shimCommand, env: { CLIO_TOKEN: TOKEN } })
    expect(l.env).toEqual({})
  })

  it('codex: MCP via -c overrides, token forwarded from its own environment, prompt plus task as first message', () => {
    const l = buildLaunch({ provider: 'codex', role: 'orchestrator', task: 'Do X', prompts, mcp })
    expect(l.args).toContain(`mcp_servers.clio.command=${JSON.stringify(mcp.node)}`)
    expect(l.args).toContain(`mcp_servers.clio.args=${JSON.stringify(shimCommand)}`)
    expect(l.args).toContain('mcp_servers.clio.env_vars=["CLIO_TOKEN"]')
    expect(l.env).toEqual({ CLIO_TOKEN: TOKEN })
    expect(l.args[l.args.length - 1]).toBe('ORCH-PROMPT\n\nDo X')
  })

  it('opencode: MCP (with the token in its environment) via OPENCODE_CONFIG_CONTENT, first message via --prompt', () => {
    const l = buildLaunch({ provider: 'opencode', role: 'orchestrator', task: '', prompts, mcp })
    expect(JSON.parse(l.env.OPENCODE_CONFIG_CONTENT).mcp.clio).toEqual({
      type: 'local',
      command: [mcp.node, ...shimCommand],
      enabled: true,
      environment: { CLIO_TOKEN: TOKEN }
    })
    expect(l.args).toEqual(['--prompt', 'ORCH-PROMPT'])
  })

  it('a worker gets the worker prompt and no MCP at all', () => {
    for (const provider of ['claude', 'codex', 'opencode'] as const) {
      const l = buildLaunch({ provider, role: 'worker', task: 'T', prompts, mcp })
      const all = JSON.stringify(l)
      expect(all, provider).toContain('WORKER-PROMPT')
      expect(all, provider).not.toContain('clio')
      expect(all, provider).not.toContain(TOKEN)
      expect(l.files, provider).toEqual([])
    }
  })

  it('plain shells get neither prompt nor MCP, and no task argument', () => {
    expect(buildLaunch({ provider: 'cmd', role: 'plain', task: 'ignored', prompts, mcp })).toEqual({ args: [], env: {}, files: [] })
    expect(buildLaunch({ provider: 'pwsh', role: 'plain', task: '', prompts, mcp })).toEqual({ args: ['-NoLogo'], env: {}, files: [] })
  })

  it('a plain AI tile knows the organizer: its own short prompt and the clio tools (Marco, 2026-09-25)', () => {
    const l = buildLaunch({ provider: 'claude', role: 'plain', task: 'hi', prompts, mcp })
    expect(l.args).toEqual(['--append-system-prompt', 'AGENT-PROMPT', '--mcp-config', mcp.configFile, 'hi'])
    expect(l.files).toHaveLength(1)
    const codex = buildLaunch({ provider: 'codex', role: 'plain', task: '', prompts, mcp })
    expect(codex.args).toContain('mcp_servers.clio.env_vars=["CLIO_TOKEN"]')
  })

  it('a plain codex/opencode tile WITHOUT a task sends no first message: no model call on start (cold review)', () => {
    // Their prompt can only go in as a first message; the rules they need also sit in the clio tool
    // descriptions, which every client reads without a turn.
    const codex = buildLaunch({ provider: 'codex', role: 'plain', task: '', prompts, mcp })
    expect(codex.args.some((a) => a.includes('AGENT-PROMPT'))).toBe(false)
    expect(buildLaunch({ provider: 'opencode', role: 'plain', task: '', prompts, mcp }).args).toEqual([])
    // with a task the prompt goes along with it
    expect(buildLaunch({ provider: 'codex', role: 'plain', task: 'Do X', prompts, mcp }).args.at(-1)).toBe('AGENT-PROMPT\n\nDo X')
  })

  it('hasOrganizerTools: every orchestrator and every plain AI tile; never a worker or a plain shell', () => {
    for (const p of ['claude', 'codex', 'opencode'] as const) {
      expect(hasOrganizerTools(p, 'plain'), p).toBe(true)
      expect(hasOrganizerTools(p, 'orchestrator'), p).toBe(true)
      expect(hasOrganizerTools(p, 'worker'), p).toBe(false)
    }
    for (const p of ['cmd', 'pwsh'] as const) {
      expect(hasOrganizerTools(p, 'plain'), p).toBe(false)
      expect(hasOrganizerTools(p, 'worker'), p).toBe(false)
      // a shell orchestrator exists only in the selftest (no model call); buildLaunch gives shells no MCP config anyway
      expect(hasOrganizerTools(p, 'orchestrator'), p).toBe(true)
    }
  })

  // Flags read from the installed CLIs' --help on 2026-09-25: claude 2.1.282 -c/--continue,
  // codex-cli 0.155.1 `resume --last` (takes -c too), opencode -c/--continue.
  describe('resume (a workspace continues the last conversation in the folder)', () => {
    it('claude continues; its role prompt and MCP stay, no new first message', () => {
      const l = buildLaunch({ provider: 'claude', role: 'orchestrator', task: 'new task', prompts, mcp, resume: true })
      expect(l.args).toEqual(['--append-system-prompt', 'ORCH-PROMPT', '--mcp-config', mcp.configFile, '--continue'])
    })
    it('codex resumes the last session and keeps the MCP config, no first message', () => {
      const l = buildLaunch({ provider: 'codex', role: 'orchestrator', task: 'T', prompts, mcp, resume: true })
      expect(l.args.slice(0, 2)).toEqual(['resume', '--last'])
      expect(l.args).toContain('mcp_servers.clio.env_vars=["CLIO_TOKEN"]')
      expect(l.args.some((a) => a.includes('ORCH-PROMPT'))).toBe(false)
      expect(l.env).toEqual({ CLIO_TOKEN: TOKEN })
    })
    it('opencode continues instead of a new prompt', () => {
      expect(buildLaunch({ provider: 'opencode', role: 'plain', task: 'T', prompts, mcp, resume: true }).args).toEqual(['--continue'])
    })
    it('shells ignore it', () => {
      expect(buildLaunch({ provider: 'pwsh', role: 'plain', task: '', prompts, mcp, resume: true }).args).toEqual(['-NoLogo'])
    })
  })
})
