import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { materializeCockpitPlugin } from './plugin'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'clio-persistent-plugin-')); directories.push(root)
  const source = join(root, 'portable-resources', 'cockpit-plugin')
  cpSync(resolve('resources/cockpit-plugin'), source, { recursive: true })
  const data = join(root, 'app-data')
  return { root, source, data }
}

it('keeps the real hook writer usable after the portable resource directory disappears', () => {
  const { root, source, data } = setup()
  const persistent = materializeCockpitPlugin(source, data)
  expect(persistent).toBe(join(data, 'cockpit-plugin'))
  const manifest = JSON.parse(readFileSync(join(persistent, 'hooks', 'hooks.json'), 'utf8'))
  expect(manifest.hooks.Stop[0].hooks[0].args).toEqual(['${CLAUDE_PLUGIN_ROOT}/cockpit-hook.cjs'])
  rmSync(source, { recursive: true, force: true })
  const home = join(root, 'test-home'); mkdirSync(home)
  const payload = { session_id: 'persistent-plugin-session', cwd: root, hook_event_name: 'Stop' }
  const result = spawnSync(process.execPath, [join(persistent, 'cockpit-hook.cjs')], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000, windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home }
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
  const spool = join(home, '.cli-organizer', 'cockpit-spool')
  const files = readdirSync(spool)
  expect(files).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(spool, files[0]), 'utf8'))).toMatchObject(payload)
})

it('reuses an identical bundle without rewriting its existing files', () => {
  const { source, data } = setup()
  const persistent = materializeCockpitPlugin(source, data)
  const script = join(persistent, 'cockpit-hook.cjs')
  const before = statSync(script, { bigint: true })
  expect(materializeCockpitPlugin(source, data)).toBe(persistent)
  const after = statSync(script, { bigint: true })
  expect(after.ino).toBe(before.ino)
  expect(after.mtimeNs).toBe(before.mtimeNs)
})

it('does not publish an incomplete bundle when a source file is missing', () => {
  const { source, data } = setup()
  rmSync(join(source, 'cockpit-hook.cjs'))
  expect(() => materializeCockpitPlugin(source, data)).toThrow()
  expect(existsSync(join(data, 'cockpit-plugin'))).toBe(false)
})

it.skipIf(process.platform !== 'win32')('rejects an existing target junction outside the app data directory', () => {
  const { root, source, data } = setup()
  const outside = join(root, 'outside'); mkdirSync(outside)
  mkdirSync(data)
  symlinkSync(outside, join(data, 'cockpit-plugin'), 'junction')
  expect(() => materializeCockpitPlugin(source, data)).toThrow(/outside|escape|link/i)
  expect(readdirSync(outside)).toEqual([])
})

it.skipIf(process.platform !== 'win32')('rejects a nested target junction before writing through it', () => {
  const { root, source, data } = setup()
  const outside = join(root, 'outside'); mkdirSync(outside)
  const target = join(data, 'cockpit-plugin'); mkdirSync(target, { recursive: true })
  symlinkSync(outside, join(target, '.claude-plugin'), 'junction')
  expect(() => materializeCockpitPlugin(source, data)).toThrow(/outside|escape|link/i)
  expect(readdirSync(outside)).toEqual([])
})
