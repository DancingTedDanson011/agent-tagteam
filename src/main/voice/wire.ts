// Voice input: audio from the page -> local Whisper -> typed into the chosen terminal (never Enter).
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { parseSessionId } from '../../shared/validate'
import { parseVoiceSettings, type VoiceResult, type VoiceSettings } from '../../shared/voice'
import type { HWND } from '../win32/api'
import * as w from '../win32/api'
import * as ax from '../win32/async'
import { typeUnicode } from '../win32/typing'
import { dictation, pythonCandidates } from './deliver'
import { VoiceWorker, type VoiceProcess } from './worker'

const MAX_AUDIO = 25 * 1024 * 1024 // a few minutes of opus
const RECOGNIZE_TIMEOUT_MS = 180_000 // the first request loads the model (12.6 s measured, more on CPU)

type Deps = {
  settings(): unknown
  saveSettings(voice: VoiceSettings): void
  /** An agent tile: its text goes into the PTY. */
  writeAgent(id: string, text: string): boolean
  /** A captured window. */
  captured(id: string): { hwnd: HWND } | undefined
}

export function wireVoice(deps: Deps): { stop(): void } {
  const size = (p: string) => {
    try {
      return statSync(p).size
    } catch {
      return -1
    }
  }
  const script = app.isPackaged ? join(process.resourcesPath, 'clio-whisper.py') : join(app.getAppPath(), 'resources', 'clio-whisper.py')
  let model = parseVoiceSettings(deps.settings()).model
  const makeWorker = () =>
    new VoiceWorker(() => {
      const python = pythonCandidates(process.env.PATH ?? '', size)[0]
      if (!python) throw new Error('no-python')
      return spawn(python, ['-u', script, model], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }) as unknown as VoiceProcess
    }, { timeoutMs: RECOGNIZE_TIMEOUT_MS })
  let worker = makeWorker()

  ipcMain.handle('voice:settings:load', () => parseVoiceSettings(deps.settings()))
  ipcMain.handle('voice:settings:save', (_e, raw) => {
    const s = parseVoiceSettings(raw)
    deps.saveSettings(s)
    if (s.model !== model) {
      model = s.model
      worker.stop()
      worker = makeWorker()
    }
    return s
  })

  ipcMain.handle('voice:transcribe', async (_e, rawAudio, rawTarget): Promise<VoiceResult> => {
    const target = parseSessionId(rawTarget)
    if (!target) return { ok: false, reason: 'no-target' }
    if (!(rawAudio instanceof Uint8Array) || rawAudio.length === 0 || rawAudio.length > MAX_AUDIO) return { ok: false, reason: 'failed', detail: 'audio' }
    const dir = mkdtempSync(join(tmpdir(), 'clio-voice-'))
    const file = join(dir, 'speech.webm')
    try {
      writeFileSync(file, rawAudio)
      const lang = parseVoiceSettings(deps.settings()).lang
      let text: string
      try {
        text = dictation(await worker.transcribe(file, lang === 'auto' ? null : lang))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return msg === 'no-python' || /faster-whisper not available/.test(msg) ? { ok: false, reason: 'no-python', detail: msg } : { ok: false, reason: 'failed', detail: msg }
      }
      if (!text) return { ok: false, reason: 'empty' }
      if (target.startsWith('a')) return deps.writeAgent(target, text) ? { ok: true, text } : { ok: false, reason: 'no-target' }
      const s = deps.captured(target)
      if (!s) return { ok: false, reason: 'no-target' }
      await ax.setForeground(s.hwnd)
      await new Promise((r) => setTimeout(r, 120)) // let the window take the keyboard first
      // Keystrokes go to whatever is in front: if the user clicked elsewhere meanwhile, Windows may
      // refuse the switch — then nothing is typed rather than typed into a stranger's window.
      if (w.GetForegroundWindow() !== s.hwnd) return { ok: false, reason: 'not-in-front', detail: text }
      typeUnicode(text)
      return { ok: true, text }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  return { stop: () => worker.stop() }
}
