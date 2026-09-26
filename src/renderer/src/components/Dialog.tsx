import { useEffect, useRef, type ReactNode } from 'react'
import { useT } from '../i18n'
import { Icon } from './Icon'

/** Native modal dialog: focus trap, Escape and backdrop come from the platform. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const t = useT()
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
    return () => d?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div className="dialog-head">
        <h2 id="dialog-title">{title}</h2>
        <button type="button" className="icon-button" onClick={onClose}>
          <Icon name="close" />
          <span className="sr-only">{t.close}</span>
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  )
}
