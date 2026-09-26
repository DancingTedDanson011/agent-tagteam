import { useT } from '../i18n'

export function EmptyState({ onPicker }: { onPicker: () => void }) {
  const t = useT()
  return (
    <section className="empty" aria-labelledby="empty-title">
      <div className="empty-figure" aria-hidden="true">
        <span className="ghost-window" />
        <span className="ghost-arrow" />
        <span className="ghost-target" />
      </div>
      <h2 id="empty-title">{t.emptyTitle}</h2>
      <p>{t.emptyBody}</p>
      {/* Secondary on purpose: dragging is the main action, the title bar holds the one primary button. */}
      <button type="button" className="button is-quiet" onClick={onPicker}>
        {t.emptyShowOpen}
      </button>
      <p className="hint">{t.emptyPromise}</p>
    </section>
  )
}
