// INTENTIONAL-UNTESTED: React glue; the tap/hold rule is unit-tested (shared/voice.ts holdStep), the
// flow (permission, recording, recognition, typing into a tile) by the in-app selftest.
import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_VOICE, HOLD_MS, holdStep, type HoldState, type VoiceResult, type VoiceSettings } from '../../shared/voice'
import { useT } from './i18n'
import { createRecorder } from './recorder'

export type VoiceState = 'idle' | 'listening' | 'recognizing'
export type Voice = {
  state: VoiceState
  level: number
  message: string | null
  settings: VoiceSettings
  setSettings(s: VoiceSettings): void
  toggle(): void
}

const MESSAGE_MS = 6000

/** The tile a dictation goes to: the terminal that had the keyboard last, else the big one. */
function useLastTile(fallback: string | null): () => string | null {
  const last = useRef<string | null>(null)
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const id = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-id]')?.dataset.id
      if (id) last.current = id
    }
    document.addEventListener('focusin', onFocus)
    return () => document.removeEventListener('focusin', onFocus)
  }, [])
  const fb = useRef(fallback)
  fb.current = fallback
  return useCallback(() => last.current ?? fb.current, [])
}

export function useVoice(focusId: string | null, sessionIds: string[], paused: boolean): Voice {
  const t = useT()
  const [state, setState] = useState<VoiceState>('idle')
  const [level, setLevel] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [settings, setSettingsState] = useState<VoiceSettings>(DEFAULT_VOICE)
  const recorder = useRef(createRecorder())
  const target = useRef<string | null>(null)
  const lastTile = useLastTile(focusId)
  const stateRef = useRef(state)
  stateRef.current = state
  const ids = useRef(sessionIds)
  ids.current = sessionIds

  useEffect(() => {
    void window.organizer.voiceSettings().then(setSettingsState)
  }, [])
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(null), MESSAGE_MS)
    return () => clearTimeout(timer)
  }, [message])

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return
    const tile = lastTile()
    if (!tile || !ids.current.includes(tile)) return setMessage(t.voiceNoTarget)
    target.current = tile
    stateRef.current = 'listening'
    setState('listening')
    setMessage(null)
    try {
      await recorder.current.start(setLevel)
    } catch {
      stateRef.current = 'idle'
      setState('idle')
      setMessage(t.voiceNoMic)
    }
  }, [lastTile, t])

  const stop = useCallback(async () => {
    if (stateRef.current !== 'listening') return
    stateRef.current = 'recognizing'
    setState('recognizing')
    setLevel(0)
    // INTENTIONAL-UNTESTED: glue; a failed IPC call must never leave the button stuck (cold review)
    let r: VoiceResult
    try {
      const audio = await recorder.current.stop()
      const tile = target.current
      r = tile && audio.length > 0 ? await window.organizer.transcribe(audio, tile) : { ok: false, reason: 'empty' }
    } catch {
      r = { ok: false, reason: 'failed' }
    } finally {
      stateRef.current = 'idle'
      setState('idle')
    }
    setMessage(
      r.ok
        ? t.voiceTyped(r.text)
        : { 'no-python': t.voiceNoPython, empty: t.voiceEmpty, 'no-target': t.voiceNoTarget, 'not-in-front': t.voiceNotInFront, failed: t.voiceFailed }[r.reason]
    )
  }, [t])

  const toggle = useCallback(() => void (stateRef.current === 'idle' ? start() : stop()), [start, stop])

  // The key: a short tap types its character into the tile, holding it records (released: typed in).
  const hold = useRef<HoldState>({ phase: 'idle' })
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const ours = (e: KeyboardEvent) => {
      if (paused || e.key !== settings.key || e.ctrlKey || e.altKey || e.metaKey) return false
      const el = e.target as HTMLElement | null
      // text fields of the app (folder field, dialogs) keep the key; terminals and the page do not
      return !(el && el.matches('input, textarea, select') && !el.classList.contains('xterm-helper-textarea'))
    }
    const act = (action: ReturnType<typeof holdStep>[1], e: KeyboardEvent) => {
      if (action === 'start') void start()
      else if (action === 'stop') void stop()
      else if (action === 'tap') {
        const tile = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-id]')?.dataset.id
        if (tile?.startsWith('a')) window.organizer.agentInput(tile, settings.key.length === 1 ? settings.key : '')
      }
    }
    const down = (e: KeyboardEvent) => {
      if (!ours(e)) return
      e.preventDefault()
      e.stopPropagation()
      const [next, action] = holdStep(hold.current, { type: 'down', repeat: e.repeat }, Date.now())
      hold.current = next
      act(action, e)
      if (next.phase === 'pressed' && !timer) {
        timer = setTimeout(() => {
          timer = null
          const [n, a] = holdStep(hold.current, { type: 'timer' }, Date.now())
          hold.current = n
          act(a, e)
        }, HOLD_MS)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key !== settings.key || hold.current.phase === 'idle') return
      e.preventDefault()
      e.stopPropagation()
      if (timer) clearTimeout(timer)
      timer = null
      const [next, action] = holdStep(hold.current, { type: 'up' }, Date.now())
      hold.current = next
      act(action, e)
    }
    // INTENTIONAL-UNTESTED: the key-up of a held key never comes when the app loses focus (Alt+Tab, a
    // click into a captured window): end cleanly instead of recording on (cold review).
    const blur = () => {
      if (timer) clearTimeout(timer)
      timer = null
      const was = hold.current.phase
      hold.current = { phase: 'idle' }
      // dropped, not typed: half a dictation must not land anywhere after a window switch
      if (was === 'recording' && stateRef.current === 'listening') {
        recorder.current.cancel()
        stateRef.current = 'idle'
        setState('idle')
        setLevel(0)
        setMessage(t.voiceCancelled)
      }
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
      if (timer) clearTimeout(timer)
    }
  }, [settings.key, paused, start, stop, t])

  const setSettings = useCallback((s: VoiceSettings) => {
    void window.organizer.saveVoiceSettings(s).then(setSettingsState)
  }, [])

  return { state, level, message, settings, setSettings, toggle }
}
