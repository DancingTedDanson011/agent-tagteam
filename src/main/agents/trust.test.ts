import { describe, expect, it } from 'vitest'
import { autoTrust, isInsideFolder, isTrustDialogFor, trustKeys } from './trust'

describe('isInsideFolder', () => {
  it.each([
    ['C:\\work', 'C:\\work', true],
    ['C:\\work\\sub\\deep', 'C:\\work', true],
    ['c:\\WORK\\sub', 'C:\\work', true],
    ['C:\\work\\', 'C:\\work', true],
    ['C:\\work2', 'C:\\work', false], // a neighbour, not a subfolder
    ['C:\\other', 'C:\\work', false],
    ['D:\\work', 'C:\\work', false],
    ['C:\\anything', 'C:\\', true],
    ['C:\\work\\..\\secret', 'C:\\work', false], // not normalizable: refused
    ['C:\\wor\u212A\\sub', 'C:\\work', false] // KELVIN SIGN: another folder on NTFS, "k" to toLowerCase (cold review)
  ])('%s in %s -> %s', (child, parent, want) => {
    expect(isInsideFolder(child, parent)).toBe(want)
  })
})

describe('autoTrust', () => {
  const worker = { provider: 'claude' as const, role: 'worker' as const, cwd: 'C:\\work\\sub', parentId: 'a1' }
  const parent = { cwd: 'C:\\work', exited: false }
  it("a Claude worker in its starting tile's folder (or below) is trusted by the organizer", () => {
    expect(autoTrust(worker, parent)).toBe(true)
    expect(autoTrust({ ...worker, cwd: 'C:\\work' }, parent)).toBe(true)
  })
  it('never outside that folder, never without a running parent, never for tiles the user started', () => {
    expect(autoTrust({ ...worker, cwd: 'C:\\elsewhere' }, parent)).toBe(false)
    expect(autoTrust(worker, undefined)).toBe(false)
    expect(autoTrust(worker, { ...parent, exited: true })).toBe(false)
    expect(autoTrust({ ...worker, role: 'plain' as const, parentId: null }, parent)).toBe(false)
    expect(autoTrust({ ...worker, provider: 'codex' as const }, parent)).toBe(false)
  })
})

describe('isTrustDialogFor: only the real start dialog for exactly this folder (cold review)', () => {
  const dialog = (folder: string) => [
    ' Accessing workspace:',
    ` ${folder}`,
    ' Quick safety check: Is this a project you created or one you trust?',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    ' Enter to confirm · Esc to cancel'
  ]
  it('the measured dialog for the worker folder', () => {
    expect(isTrustDialogFor(dialog('C:\\work\\sub'), 'C:\\work\\sub')).toBe(true)
    expect(isTrustDialogFor(dialog('c:\\WORK\\sub'), 'C:\\work\\sub')).toBe(true)
  })
  it('text that only looks like it (an answer, a file, another folder) does not count', () => {
    const spoof = ['Here is what the dialog looks like:', '  ❯ No, exit', '    Yes, I trust this folder', '  Enter to confirm']
    expect(isTrustDialogFor(spoof, 'C:\\work\\sub')).toBe(false)
    expect(isTrustDialogFor(dialog('C:\\other'), 'C:\\work\\sub')).toBe(false)
  })
  it('never while a numbered choice is on screen (a permission question below)', () => {
    expect(isTrustDialogFor([...dialog('C:\\work\\sub'), ' ❯ 1. Yes', '   2. Yes, and don’t ask again', '   3. No'], 'C:\\work\\sub')).toBe(false)
  })
})

describe('trustKeys', () => {
  // Measured on Claude Code 2.1.282 (2026-09-25): "No, exit" is preselected; one arrow down selects
  // "Yes, I trust this folder" and Enter confirms.
  const screen = (cursorOnYes: boolean) => [
    ' Accessing workspace:',
    ' C:\\work',
    cursorOnYes ? '   No, exit' : ' ❯ No, exit',
    cursorOnYes ? ' ❯ Yes, I trust this folder' : '   Yes, I trust this folder',
    ' Enter to confirm · Esc to cancel'
  ]
  it('moves from the cursor line to "Yes" and confirms', () => {
    expect(trustKeys(screen(false))).toEqual(['\x1b[B', '\r'])
    expect(trustKeys(screen(true))).toEqual(['\r'])
  })
  it('works whatever the order of the options', () => {
    expect(trustKeys([' ❯ Yes, I trust this folder', '   No, exit'].reverse().reverse())).toEqual(['\r'])
    expect(trustKeys(['   Yes, I trust this folder', ' ❯ No, exit'])).toEqual(['\x1b[A', '\r'])
  })
  it('nothing to press when the dialog is not recognizable', () => {
    expect(trustKeys(['Claude Code v2.1.282', '❯ Try "create a util"'])).toBeNull()
  })
})
