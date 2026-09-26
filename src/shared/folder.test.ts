import { describe, expect, it } from 'vitest'
import { detectTrustPrompt, normalizeFolder, parseClipboardText, sanitizePaste } from './folder'

const HOME = 'C:\\Users\\marco'

describe('normalizeFolder', () => {
  it.each([
    ['C:\\work\\repo', 'C:\\work\\repo'],
    ['"C:\\work\\my repo"', 'C:\\work\\my repo'], // Explorer "Copy as path"
    ["  'C:\\work'  ", 'C:\\work'],
    ['C:/work/repo/', 'C:\\work\\repo'],
    ['c:\\', 'c:\\'],
    ['~', HOME],
    ['~\\Desktop', `${HOME}\\Desktop`],
    ['%USERPROFILE%\\Desktop', `${HOME}\\Desktop`],
    ['%userprofile%/Desktop', `${HOME}\\Desktop`],
    ['\\\\nas\\share\\x', '\\\\nas\\share\\x']
  ])('%s -> %s', (raw, want) => {
    expect(normalizeFolder(raw, HOME)).toBe(want)
  })
  it.each(['', '   ', 'repo', '.\\x', '..\\x', 'C:relative', '%OTHER%\\x', 'C:\\a\\..\\b', 'x'.repeat(2000), '\\\\?\\C:\\work', '\\\\?\\GLOBALROOT\\Device\\x', '\\\\.\\pipe\\x'])('refuses %j', (raw) => {
    expect(normalizeFolder(raw, HOME)).toBeNull()
  })
})

describe('parseClipboardText', () => {
  it('passes text up to 1 MB, refuses anything else', () => {
    expect(parseClipboardText('hallo')).toBe('hallo')
    expect(parseClipboardText('x'.repeat(1024 * 1024 + 1))).toBeNull()
    expect(parseClipboardText(42)).toBeNull()
  })
})

describe('sanitizePaste', () => {
  it('removes escape and control characters, so pasted text can never end a bracketed paste (cold review)', () => {
    const attack = 'echo harmless\x1b[201~\ncalc.exe\n'
    const clean = sanitizePaste(attack)
    expect(clean).not.toContain('\x1b')
    expect(clean).toBe('echo harmless[201~\ncalc.exe\n')
  })
  it('keeps text, tabs and line breaks', () => {
    expect(sanitizePaste('a\tb\r\nc ä ✓')).toBe('a\tb\r\nc ä ✓')
    expect(sanitizePaste('x\u0007\u009by')).toBe('xy') // BEL and the 8-bit CSI too
  })
})

describe('detectTrustPrompt', () => {
  it('does not fire when a tile merely quotes the dialog (e.g. an orchestrator reading a worker)', () => {
    expect(detectTrustPrompt(['Worker a3 shows: "❯ No, exit" and "Yes, I trust this folder" - shall I?'])).toBe(false)
  })
  it("recognizes Claude Code's folder trust question (measured screen text, 2026-09-24)", () => {
    const screen = [
      ' Accessing workspace:',
      ' C:\\work',
      ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      ' Enter to confirm · Esc to cancel'
    ]
    expect(detectTrustPrompt(screen)).toBe(true)
    expect(detectTrustPrompt(['> hallo', 'Marco, mir geht es gut.'])).toBe(false)
  })
})
