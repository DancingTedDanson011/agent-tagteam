// Types text into the foreground window as Unicode keystrokes (SendInput + KEYEVENTF_UNICODE): the
// way a person types, so it works in classic consoles and Windows Terminal alike. Used for voice
// input into captured windows; agent tiles get their text through their PTY instead.
import * as w from './api'

const INPUT_KEYBOARD = 1
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004

/** Returns how many key events Windows accepted (2 per UTF-16 unit when all went through). */
export function typeUnicode(text: string): number {
  const inputs: Array<Record<string, unknown>> = []
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    for (const flags of [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP]) {
      inputs.push({ type: INPUT_KEYBOARD, ki: { wVk: 0, wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 }, pad: new Array(8).fill(0) })
    }
  }
  if (inputs.length === 0) return 0
  return w.SendInput(inputs.length, inputs, w.koffi.sizeof(w.INPUT))
}
