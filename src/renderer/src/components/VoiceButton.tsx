// INTENTIONAL-UNTESTED: presentational; the flow is pinned by the in-app selftest, the states by the
// design-beweis probe.
import { useState } from 'react'
import type { VoiceLang, VoiceModel, VoiceSettings } from '../../../shared/voice'
import { useT } from '../i18n'
import type { Voice } from '../useVoice'
import { Dialog } from './Dialog'
import { Icon } from './Icon'

/** Human name of a key (KeyboardEvent.key) for the button title and the settings. */
const keyName = (k: string) => (k === ' ' ? 'Space' : k)

export function VoiceButton({ voice, onSettings }: { voice: Voice; onSettings: () => void }) {
  const t = useT()
  const label = voice.state === 'listening' ? t.voiceListening : voice.state === 'recognizing' ? t.voiceRecognizing : t.voiceButton
  return (
    <div className="voice">
      <button
        type="button"
        className={`button voice-button is-${voice.state}`}
        aria-pressed={voice.state === 'listening'}
        onClick={voice.toggle}
        disabled={voice.state === 'recognizing'}
        title={t.voiceTitle(keyName(voice.settings.key))}
      >
        <span className="voice-dot" style={{ transform: `scale(${1 + voice.level * 0.8})` }} aria-hidden="true" />
        {label}
      </button>
      <button type="button" className="icon-button voice-settings" onClick={onSettings} title={t.voiceSettings}>
        <Icon name="settings" />
        <span className="sr-only">{t.voiceSettings}</span>
      </button>
      <span className="voice-message" role="status" aria-live="polite">
        {voice.message}
      </span>
    </div>
  )
}

export function VoiceSettingsDialog({ settings, onSave, onClose }: { settings: VoiceSettings; onSave: (s: VoiceSettings) => void; onClose: () => void }) {
  const t = useT()
  const [draft, setDraft] = useState(settings)
  const [capturing, setCapturing] = useState(false)
  return (
    <Dialog title={t.voiceSettings} onClose={onClose}>
      <form
        className="style-form"
        onSubmit={(e) => {
          e.preventDefault()
          onSave(draft)
          onClose()
        }}
      >
        <span className="field-label">{t.voiceKey}</span>
        <button
          type="button"
          className="button key-capture"
          aria-pressed={capturing}
          onClick={() => setCapturing(true)}
          onKeyDown={(e) => {
            if (!capturing || e.key === 'Tab') return
            e.preventDefault()
            e.stopPropagation()
            if (e.key !== 'Escape') setDraft({ ...draft, key: e.key })
            setCapturing(false)
          }}
        >
          {capturing ? t.voicePressKey : keyName(draft.key)}
        </button>
        <p className="hint">{t.voiceKeyHint}</p>
        <label htmlFor="voice-lang">{t.voiceLang}</label>
        <select id="voice-lang" className="plain-select" value={draft.lang} onChange={(e) => setDraft({ ...draft, lang: e.target.value as VoiceLang })}>
          {(['auto', 'de', 'en'] as const).map((l) => (
            <option key={l} value={l}>
              {t.voiceLangs[l]}
            </option>
          ))}
        </select>
        <label htmlFor="voice-model">{t.voiceModel}</label>
        <select id="voice-model" className="plain-select" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value as VoiceModel })}>
          {(['large-v3-turbo', 'large-v3', 'base'] as const).map((m) => (
            <option key={m} value={m}>
              {t.voiceModels[m]}
            </option>
          ))}
        </select>
        <div className="dialog-actions">
          <button type="submit" className="button is-primary">
            {t.styleApply}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
