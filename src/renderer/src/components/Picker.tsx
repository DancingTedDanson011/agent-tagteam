// INTENTIONAL-UNTESTED: dialog component without a unit harness (no DOM test dependency); exercised by
// the in-app selftest (stays open after a capture) and the Playwright preview probe.
import { useEffect, useState } from 'react'
import type { CaptureCandidate, RefusalReason } from '../../../shared/types'
import { useT } from '../i18n'
import { cleanTitle } from '../workspaces'
import { Dialog } from './Dialog'

type Load = { state: 'loading' } | { state: 'ready'; list: CaptureCandidate[] } | { state: 'error' }

/** Stays open after a capture (several terminals in a row); only X or Escape close it. */
export function Picker({ onClose, onCaptured }: { onClose: () => void; onCaptured: (id: string) => void }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [refused, setRefused] = useState<RefusalReason | null>(null)
  const t = useT()

  useEffect(() => {
    window.organizer.listCandidates().then(
      (list) => setLoad({ state: 'ready', list }),
      () => setLoad({ state: 'error' })
    )
  }, [])

  const capture = async (c: CaptureCandidate) => {
    setBusy(c.hwnd)
    setFailed(false)
    setRefused(null)
    try {
      const result = await window.organizer.capture(c.hwnd)
      if (result.ok) {
        setLoad((l) => (l.state === 'ready' ? { state: 'ready', list: l.list.filter((x) => x.hwnd !== c.hwnd) } : l))
        onCaptured(result.id)
      } else setRefused(result.reason)
    } catch {
      setFailed(true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog title={t.capture} onClose={onClose}>
      <p className="hint">{t.pickerHint}</p>
      {load.state === 'loading' && <p className="hint">{t.pickerLoading}</p>}
      {failed && (
        <p className="error" role="alert">
          {t.pickerFailed}
        </p>
      )}
      {refused && (
        <p className="error" role="alert">
          {t.refusal[refused]}
        </p>
      )}
      {load.state === 'error' && <p className="error">{t.pickerListError}</p>}
      {load.state === 'ready' && load.list.length === 0 && <p className="hint">{t.pickerNone}</p>}
      {load.state === 'ready' && load.list.length > 0 && (
        <ul className="candidate-list">
          {load.list.map((c) => (
            <li key={c.hwnd} className="candidate" data-hwnd={c.hwnd}>
              <div className="candidate-text">
                <span className="candidate-title">{cleanTitle(c.title) || c.processName}</span>
                <span className="candidate-meta">
                  {c.processName}
                  {c.heldBy === 'instance' && ` · ${t.inOtherOrganizer}`}
                  {c.heldBy === 'legacy' && ` · ${t.releaseThereFirst}`}
                  {c.heldBy === 'stale' && ` · ${t.staleHolder}`}
                </span>
              </div>
              {(c.heldBy === undefined || c.heldBy === 'instance') && (
                <button
                  type="button"
                  className={`button ${c.heldBy ? 'is-quiet' : 'is-primary'}`}
                  disabled={busy !== null}
                  onClick={() => void capture(c)}
                >
                  {busy === c.hwnd
                    ? c.heldBy
                      ? t.takingOver
                      : t.pickerCapturing
                    : c.heldBy
                      ? t.takeOver
                      : t.pickerCaptureOne}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
