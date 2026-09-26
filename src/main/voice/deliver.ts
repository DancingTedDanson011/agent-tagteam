// Pure helpers of the voice input: what text may be typed, and which Python runs the recognizer.
import { join } from 'node:path'
import { sanitizePaste } from '../../shared/folder'

/**
 * The recognized text as it reaches a terminal: one line, no control characters, and never an Enter
 * — the user reads it and presses Enter (or not).
 */
export function dictation(text: string): string {
  return sanitizePaste(text.replace(/[\r\n]+/g, ' ')).replace(/\s+/g, ' ').trim()
}

/**
 * python.exe from PATH, in order: absolute folders only (a relative one is the working folder), and
 * never the 0-byte WindowsApps alias (it opens the Store instead of running Python).
 */
export function pythonCandidates(pathEnv: string, size: (p: string) => number): string[] {
  const out: string[] = []
  for (const dir of pathEnv.split(';')) {
    if (!/^[a-zA-Z]:\\/.test(dir)) continue
    const p = join(dir, 'python.exe')
    if (size(p) > 0 && !out.includes(p)) out.push(p)
  }
  return out
}
