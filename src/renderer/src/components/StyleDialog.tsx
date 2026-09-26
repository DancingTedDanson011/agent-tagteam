// INTENTIONAL-UNTESTED: presentational dialog without a unit harness (no DOM test dependency); the
// name/colour rules are unit-tested in shared/restore.ts, the dialog by the in-app selftest and the
// design-beweis probe.
import { createContext, useContext, useState } from 'react'
import { COLORS } from '../../../shared/restore'
import type { ColorId, SessionInfo } from '../../../shared/types'
import { useT } from '../i18n'
import { Dialog } from './Dialog'

/** Opens the name-and-colour dialog for a session (provided by App, used by every header). */
export const StyleContext = createContext<(id: string) => void>(() => undefined)
export const useOpenStyle = () => useContext(StyleContext)

const COLOR_IDS = Object.keys(COLORS) as ColorId[]

export function StyleDialog({ session, onClose }: { session: SessionInfo; onClose: () => void }) {
  const t = useT()
  const [label, setLabel] = useState(session.label ?? '')
  const [color, setColor] = useState<ColorId | null>(session.color ?? null)
  const apply = () => {
    window.organizer.setSessionStyle(session.id, { label, ...(color ? { color } : {}) })
    onClose()
  }
  return (
    <Dialog title={t.styleTitle} onClose={onClose}>
      <form
        className="style-form"
        onSubmit={(e) => {
          e.preventDefault()
          apply()
        }}
      >
        <label htmlFor="style-name">{t.styleName}</label>
        <input id="style-name" value={label} maxLength={60} placeholder={session.title} onChange={(e) => setLabel(e.target.value)} aria-describedby="style-name-hint" autoFocus />
        <p id="style-name-hint" className="hint">
          {t.styleNameHint}
        </p>
        <fieldset className="swatches">
          <legend>{t.styleColor}</legend>
          <label className={`swatch is-none${color === null ? ' is-checked' : ''}`}>
            <input type="radio" name="style-color" checked={color === null} onChange={() => setColor(null)} />
            <span className="swatch-text">{t.styleNone}</span>
          </label>
          {COLOR_IDS.map((c) => (
            <label key={c} className={`swatch${color === c ? ' is-checked' : ''}`} style={{ '--swatch': COLORS[c] } as React.CSSProperties} title={t.colorName[c]}>
              <input type="radio" name="style-color" checked={color === c} onChange={() => setColor(c)} />
              <span className="swatch-chip" aria-hidden="true" />
              <span className="sr-only">{t.colorName[c]}</span>
            </label>
          ))}
        </fieldset>
        <div className="dialog-actions">
          <button type="submit" className="button is-primary">
            {t.styleApply}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
