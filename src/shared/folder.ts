// Folders typed or pasted by the user (quick-launch bar) or named by an orchestrator, the clipboard
// bridge, and the one agent prompt the page warns about.

const MAX_PATH = 1024
const MAX_CLIPBOARD = 1024 * 1024

/**
 * A folder as people paste it into an absolute Windows path: quotes from Explorer's "Copy as path"
 * go, `/` becomes `\`, `~` and %USERPROFILE% become `home`, a trailing separator goes (except on a
 * drive root). Relative paths, `..` segments and other variables are refused (null): nobody should
 * start a program in a folder they did not name exactly.
 */
export function normalizeFolder(raw: string, home: string): string | null {
  let p = raw.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
  if (!p || p.length > MAX_PATH) return null
  p = p.replace(/\//g, '\\')
  if (p === '~' || p.startsWith('~\\')) p = home + p.slice(1)
  p = p.replace(/^%userprofile%/i, home)
  if (p.includes('%')) return null
  // Device paths (\\?\…, \\.\…) are refused: nobody pastes one as a working folder.
  if (/^\\\\[?.]\\/.test(p)) return null
  if (!/^([a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+)/.test(p)) return null
  if (p.split('\\').some((seg) => seg === '..' || seg === '.')) return null
  if (p.length > 3 && p.endsWith('\\')) p = p.replace(/\\+$/, '')
  return p
}

export function parseClipboardText(v: unknown): string | null {
  return typeof v === 'string' && v.length <= MAX_CLIPBOARD ? v : null
}

/**
 * Pasted text reaches the program inside a bracketed paste. An ESC in it could end that bracket
 * (`ESC[201~`) and turn the rest into typed keys, Enter included. So ESC and every other control
 * character (C0, DEL, C1) go; only tab and line breaks stay.
 */
export function sanitizePaste(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

/**
 * Claude Code's first-run question for a folder: it defaults to "No, exit". Matched on the dialog's
 * own lines (an option line starting with the ❯ cursor, and the confirm hint) so a tile that merely
 * quotes the words does not raise the hint.
 */
export function detectTrustPrompt(screenLines: string[]): boolean {
  const text = screenLines.join('\n')
  return (
    /^\s*❯\s+(No, exit|Yes, I trust this folder)\s*$/m.test(text) &&
    /^\s*(Yes, I trust this folder|No, exit)\s*$/m.test(text) &&
    /Enter to confirm/.test(text)
  )
}
