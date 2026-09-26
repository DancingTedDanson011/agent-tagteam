// Voice input types into captured windows. Only a window started here is typed into, and closed.
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as w from '../../src/main/win32/api'
import { typeUnicode } from '../../src/main/win32/typing'
import * as win from '../../src/main/win32/windows'
import { closeSpawned, openConhost, sleep } from './helpers'

afterEach(() => closeSpawned())

describe('typing into a console window', () => {
  it('INPUT has the x64 size Windows expects', () => {
    expect(w.koffi.sizeof(w.INPUT)).toBe(40)
  })

  it('the typed text arrives in the console, umlauts included', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'clio-type-')))
    const out = join(dir, 'out.txt')
    const h = await openConhost('CLIO-TYPE', 'chcp 65001 >nul')
    w.SetForegroundWindow(h)
    await sleep(600)
    expect(win.getPid(h)).toBeGreaterThan(0)
    // Keystrokes go to whatever is in front. If Windows refused the switch (foreground lock: another
    // app is active), type NOTHING — never into the user's window. The test then fails loudly.
    const front = w.GetForegroundWindow() as bigint | null
    if (front !== h) throw new Error(`test window is not in front (foreground ${String(front)}); nothing was typed`)
    const text = `echo CLIO-VOICE-ÄÖÜ>${out}`
    expect(typeUnicode(text)).toBe(text.length * 2)
    typeUnicode('\r')
    for (let i = 0; i < 25 && !existsSync(out); i++) await sleep(200)
    expect(readFileSync(out, 'utf8').trim()).toBe('CLIO-VOICE-ÄÖÜ')
  })
})
