import { readFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('observes without stdout decisions, writes masked atomic spool files and rejects oversized input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-plugin-')); dirs.push(dir)
  const writer = resolve('resources/cockpit-plugin/cockpit-hook.cjs')
  const run = (input: string) => spawnSync(process.execPath, [writer, '--spool-dir', dir], { input, encoding: 'utf8', timeout: 5000 })
  const result = run(JSON.stringify({ session_id: 'sid', cwd: '/project', hook_event_name: 'PreToolUse', tool_input: { token: 'private-secret', command: 'curl -d {"access_token":"private-command"}' } }))
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
  const files = readdirSync(dir)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/^cockpit-[A-Za-z0-9-]+\.json$/)
  const data = readFileSync(join(dir, files[0]), 'utf8')
  expect(data).toContain('session_id')
  expect(data).not.toContain('private-secret')
  expect(data).not.toContain('private-command')
  expect(run('x'.repeat(400_000)).status).toBe(0)
  expect(readdirSync(dir).some(file => JSON.parse(readFileSync(join(dir, file), 'utf8')).cockpit_invalid)).toBe(true)
})
it('bundles only portable asynchronous observation handlers within the plugin root', () => {
  const hooks = JSON.parse(readFileSync(resolve('resources/cockpit-plugin/hooks/hooks.json'), 'utf8'))
  for (const definitions of Object.values(hooks.hooks) as { hooks: { type: string; command: string; args: string[]; async: boolean }[] }[][]) {
    for (const definition of definitions) for (const hook of definition.hooks) {
      expect(hook).toMatchObject({ type: 'command', command: 'node', async: true })
      expect(hook.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/cockpit-hook.cjs'])
    }
  }
})
it('reports a local writer failure without blocking the observed tool', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-plugin-')); dirs.push(dir)
  const blocked = join(dir, 'regular-file'); writeFileSync(blocked, 'occupied')
  const result = spawnSync(process.execPath, [resolve('resources/cockpit-plugin/cockpit-hook.cjs'), '--spool-dir', blocked], { input: '{}', encoding: 'utf8', timeout: 5000 })
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('CLI Organizer observation unavailable')
})
