// Voice input: which key starts it, which language and model the local Whisper uses, and the
// tap-or-hold rule that keeps the key usable for typing.

export type VoiceLang = 'auto' | 'de' | 'en'
export type VoiceModel = 'large-v3-turbo' | 'large-v3' | 'base'
export type VoiceSettings = { key: string; lang: VoiceLang; model: VoiceModel }

/** What a dictation did. no-python: Python with faster-whisper is missing. */
export type VoiceResult = { ok: true; text: string } | { ok: false; reason: 'no-python' | 'no-target' | 'not-in-front' | 'empty' | 'failed'; detail?: string }

/** "-" held to talk (Marco: not everyone has a numpad); a short tap still types "-". */
export const DEFAULT_VOICE: VoiceSettings = { key: '-', lang: 'auto', model: 'large-v3-turbo' }

const LANGS: readonly VoiceLang[] = ['auto', 'de', 'en']
const MODELS: readonly VoiceModel[] = ['large-v3-turbo', 'large-v3', 'base']
/** Keys a terminal cannot do without. */
const RESERVED = new Set(['Enter', 'Tab', 'Escape', 'Backspace', ' ', 'Delete'])

export function parseVoiceSettings(v: unknown): VoiceSettings {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const key = typeof o.key === 'string' && o.key.length > 0 && o.key.length <= 20 && !RESERVED.has(o.key) ? o.key : DEFAULT_VOICE.key
  const lang = LANGS.find((l) => l === o.lang) ?? DEFAULT_VOICE.lang
  const model = MODELS.find((m) => m === o.model) ?? DEFAULT_VOICE.model
  return { key, lang, model }
}

/** Holding the key this long starts recording; a shorter press is a normal keystroke. */
export const HOLD_MS = 400

export type HoldState = { phase: 'idle' } | { phase: 'pressed'; since: number } | { phase: 'recording' }
export type HoldEvent = { type: 'down'; repeat: boolean } | { type: 'up' } | { type: 'timer' }
/** tap: type the key's character · start/stop: recording. */
export type HoldAction = 'tap' | 'start' | 'stop' | null

export function holdStep(st: HoldState, ev: HoldEvent, now: number): [HoldState, HoldAction] {
  switch (st.phase) {
    case 'idle':
      return ev.type === 'down' && !ev.repeat ? [{ phase: 'pressed', since: now }, null] : [st, null]
    case 'pressed':
      if (ev.type === 'up') return [{ phase: 'idle' }, 'tap']
      if (ev.type === 'timer' && now - st.since >= HOLD_MS) return [{ phase: 'recording' }, 'start']
      return [st, null]
    case 'recording':
      return ev.type === 'up' ? [{ phase: 'idle' }, 'stop'] : [st, null]
  }
}
