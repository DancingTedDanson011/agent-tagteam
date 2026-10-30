import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wireCockpit } from './wire'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, raw?: unknown) => unknown>())
vi.mock('electron', () => ({ ipcMain: {
  handle: (name: string, handler: (event: unknown, raw?: unknown) => unknown) => handlers.set(name, handler),
  removeHandler: (name: string) => handlers.delete(name)
} }))
const disposers: Array<() => Promise<void>> = []
const directories: string[] = []
afterEach(async () => { for (const close of disposers.splice(0)) await close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); handlers.clear() })

describe('cockpit IPC boundary', () => {
  it('serves only the owning main frame, validates commands and disposes both handlers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-cockpit-ipc-')); directories.push(dir)
    const frame = {}
    const webContents = { mainFrame: frame, send: vi.fn() }
    const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow
    const wiring = wireCockpit(window, dir, { home: join(dir, 'home') }); disposers.push(() => wiring.close())
    const load = handlers.get('cockpit:load')!
    const command = handlers.get('cockpit:command')!
    await expect(load({ sender: {}, senderFrame: frame })).rejects.toThrow(/frame|sender|allowed/i)
    await expect(load({ sender: webContents, senderFrame: {} })).rejects.toThrow(/frame|sender|allowed/i)
    const event = { sender: webContents, senderFrame: frame }
    expect(await command(event, { type: 'execute', command: 'arbitrary' })).toMatchObject({ ok: false })
    expect(await load(event)).toMatchObject({ projects: [], writable: true })
    await wiring.close()
    expect(handlers.has('cockpit:load')).toBe(false)
    expect(handlers.has('cockpit:command')).toBe(false)
  })
})
