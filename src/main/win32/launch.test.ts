import { describe, expect, it } from 'vitest'
import { buildCommandLine, isAbsoluteWindowsPath, quoteArg } from './launch'

describe('quoteArg (MSVCRT command line rules)', () => {
  it('leaves simple arguments alone', () => {
    expect(quoteArg('-NoProfile')).toBe('-NoProfile')
    expect(quoteArg('12345')).toBe('12345')
  })
  it('quotes arguments with spaces (the app data folder is "CLI Organizer")', () => {
    expect(quoteArg('C:\\Users\\x\\AppData\\Roaming\\CLI Organizer\\log.txt')).toBe(
      '"C:\\Users\\x\\AppData\\Roaming\\CLI Organizer\\log.txt"'
    )
  })
  it('quotes the empty string', () => {
    expect(quoteArg('')).toBe('""')
  })
  it('doubles backslashes before a closing quote so the quote is not escaped', () => {
    expect(quoteArg('C:\\my dir\\')).toBe('"C:\\my dir\\\\"')
  })
  it('escapes embedded quotes', () => {
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""')
  })
})

describe('buildCommandLine', () => {
  it('joins the quoted executable and arguments', () => {
    expect(buildCommandLine('powershell.exe', ['-File', 'C:\\a b\\w.ps1', '-ParentPid', '42'])).toBe(
      'powershell.exe -File "C:\\a b\\w.ps1" -ParentPid 42'
    )
  })
})

describe('isAbsoluteWindowsPath', () => {
  it('accepts drive and UNC paths (the portable exe may run from a network share)', () => {
    expect(isAbsoluteWindowsPath('C:\\Windows\\System32\\x.exe')).toBe(true)
    expect(isAbsoluteWindowsPath('\\\\nas\\tools\\CLI-Organizer.exe')).toBe(true)
  })
  it('rejects anything Windows would search for', () => {
    for (const p of ['powershell.exe', '.\\x.exe', '\\x.exe', 'C:x.exe', '\\\\', '']) expect(isAbsoluteWindowsPath(p), p).toBe(false)
  })
})
