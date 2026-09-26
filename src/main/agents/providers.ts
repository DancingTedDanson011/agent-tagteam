// Which program an agent tile runs, and how its role reaches it. Only a fixed set of programs is
// ever started, directly (never through cmd.exe: a task text with & or | must stay text). Measured
// 2026-09-23 on this machine: claude.cmd and opencode.cmd wrap a native .exe, codex.cmd runs
// `node codex.js`; claude takes --append-system-prompt and --mcp-config <file>, codex accepts
// `-c mcp_servers.<name>.command/args/env_vars` (`codex mcp list` / `mcp get`), opencode reads MCP
// servers from OPENCODE_CONFIG_CONTENT and passes their `environment` (a probe server received it).
// Codex and opencode get the role text as their first message: no instructions flag was verifiable.
//
// The orchestrator's MCP token never goes on a command line (any process of the same user can read
// those — cold review): claude gets it in a config file, codex and opencode in their environment.
import { isAbsolute, join, normalize } from 'node:path'
import type { AgentProvider, AgentRole } from '../../shared/types'

export type Program = { file: string; prefix: string[] }

/**
 * The program behind an npm .cmd shim: the quoted `%dp0%\...` target that the shim RUNS — the one
 * followed by `%*` (the forwarded arguments). codex.cmd names `%dp0%\node.exe` earlier, only in an
 * IF EXIST probe; taking the first match started that missing file (Marco's run, 2026-09-24).
 */
export function resolveFromShim(shim: string, npmDir: string, node: string): Program | null {
  const m = /"%dp0%\\([^"%]+?\.(exe|js))"\s+%\*/i.exec(shim)
  if (!m) return null
  const target = normalize(join(npmDir, m[1]))
  if (!target.startsWith(normalize(npmDir) + '\\') || !isAbsolute(target)) return null
  return m[2].toLowerCase() === 'exe' ? { file: target, prefix: [] } : { file: node, prefix: [target] }
}

/** How the orchestrator's MCP shim is started and reaches this app. */
export type McpLink = { node: string; shim: string; pipe: string; token: string; configFile: string }

/** agent: a plain AI tile (works for the user itself, may open other agents as tiles). */
export type Prompts = { orchestrator: string; worker: string; agent: string }

/**
 * Which tiles get the organizer's MCP tools: every orchestrator and every plain AI tile the user started.
 * Never a worker (no agents starting agents starting agents) and never a plain shell. What a tile
 * may do with them is decided in mcp.ts (own workers, unlocked tiles).
 */
export function hasOrganizerTools(provider: AgentProvider, role: AgentRole): boolean {
  if (role === 'orchestrator') return true
  return role === 'plain' && provider !== 'cmd' && provider !== 'pwsh'
}

/** resume: continue the last conversation in the folder instead of starting one (workspaces). */
export type LaunchInput = { provider: AgentProvider; role: AgentRole; task: string; prompts: Prompts; mcp: McpLink; resume?: boolean }

/** `files` are written before the program starts (and removed when its tile goes). */
export type Launch = { args: string[]; env: Record<string, string>; files: Array<{ path: string; content: string }> }

export function buildLaunch({ provider, role, task, prompts, mcp, resume = false }: LaunchInput): Launch {
  if (provider === 'cmd') return { args: [], env: {}, files: [] }
  if (provider === 'pwsh') return { args: ['-NoLogo'], env: {}, files: [] }

  const rolePrompt = role === 'orchestrator' ? prompts.orchestrator : role === 'worker' ? prompts.worker : prompts.agent
  const withMcp = hasOrganizerTools(provider, role)
  const shimArgs = [mcp.shim, '--pipe', mcp.pipe]
  const tokenEnv = { CLIO_TOKEN: mcp.token }
  // A plain tile without a task starts silent: for codex/opencode the prompt could only go in as a
  // message, which is a model call on every start. Their rules also sit in the clio tool descriptions.
  const firstMessage = role === 'plain' && !task.trim() ? '' : [rolePrompt, task.trim()].filter(Boolean).join('\n\n')

  switch (provider) {
    case 'claude': {
      const args: string[] = []
      const files: Launch['files'] = []
      if (rolePrompt) args.push('--append-system-prompt', rolePrompt)
      if (withMcp) {
        args.push('--mcp-config', mcp.configFile)
        files.push({ path: mcp.configFile, content: JSON.stringify({ mcpServers: { clio: { command: mcp.node, args: shimArgs, env: tokenEnv } } }) })
      }
      if (resume) args.push('--continue')
      else if (task.trim()) args.push(task.trim())
      return { args, env: {}, files }
    }
    case 'codex': {
      // TOML values; JSON strings and arrays are valid TOML here.
      const mcpArgs = withMcp
        ? [
            '-c',
            `mcp_servers.clio.command=${JSON.stringify(mcp.node)}`,
            '-c',
            `mcp_servers.clio.args=${JSON.stringify(shimArgs)}`,
            '-c',
            'mcp_servers.clio.env_vars=["CLIO_TOKEN"]'
          ]
        : []
      // The resumed conversation already holds its first message.
      const args = resume ? ['resume', '--last', ...mcpArgs] : firstMessage ? [...mcpArgs, firstMessage] : mcpArgs
      return { args, env: withMcp ? tokenEnv : {}, files: [] }
    }
    case 'opencode': {
      const env: Record<string, string> = withMcp
        ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { clio: { type: 'local', command: [mcp.node, ...shimArgs], enabled: true, environment: tokenEnv } } }) }
        : {}
      return { args: resume ? ['--continue'] : firstMessage ? ['--prompt', firstMessage] : [], env, files: [] }
    }
  }
}
