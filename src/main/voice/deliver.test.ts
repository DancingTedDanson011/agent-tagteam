import { describe, expect, it } from 'vitest'
import { dictation, pythonCandidates } from './deliver'

describe('dictation: what reaches the terminal', () => {
  it('one line of plain text, never an Enter or a control sequence', () => {
    expect(dictation(' Hallo Organizer,\nliste alle Dateien auf. ')).toBe('Hallo Organizer, liste alle Dateien auf.')
    expect(dictation('rm -rf /\r\n')).toBe('rm -rf /')
    expect(dictation('a\x1b[201~b\x07c')).toBe('a[201~bc')
  })
  it('nothing recognized is nothing typed', () => {
    expect(dictation('   ')).toBe('')
  })
})

describe('pythonCandidates', () => {
  it('python.exe from PATH in order, absolute folders only, never the empty WindowsApps alias', () => {
    const sizes: Record<string, number> = {
      'C:\\conda\\python.exe': 93184,
      'C:\\Users\\m\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe': 0
    }
    const size = (p: string) => sizes[p] ?? -1
    expect(pythonCandidates('.;C:\\Users\\m\\AppData\\Local\\Microsoft\\WindowsApps;C:\\conda;C:\\missing', size)).toEqual(['C:\\conda\\python.exe'])
  })
})
