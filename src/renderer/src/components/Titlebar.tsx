// INTENTIONAL-UNTESTED: presentational component without a unit harness (no DOM test dependency);
// exercised by the in-app selftest (view buttons, bring back) and measured by the design-beweis probe.
import type { DragState, Lang, ViewMode, Workspace } from '../../../shared/types'
import { useT, type Dict } from '../i18n'
import { Icon, type IconName } from './Icon'

const VIEWS: Array<{ id: ViewMode; icon: IconName; key: string }> = [
  { id: 'focus', icon: 'focus', key: '1' },
  { id: 'grid', icon: 'grid', key: '2' },
  { id: 'free', icon: 'free', key: '3' },
  { id: 'tabs', icon: 'tabs', key: '4' }
]
const LANGS: Lang[] = ['de', 'en']

type Props = {
  view: ViewMode
  drag: DragState
  workspace: Workspace | null
  hasSessions: boolean
  lang: Lang
  onLang: (l: Lang) => void
  onView: (v: ViewMode) => void
  onPicker: () => void
  onWorkspaces: () => void
  onAgent: () => void
}

function dropHint(drag: DragState, t: Dict): string {
  if (drag.kind === 'reseat') return drag.over ? t.dropReseatOver : t.dropReseat
  return drag.over ? t.dropCaptureOver : t.dropCapture
}

export function Titlebar({ view, drag, workspace, hasSessions, lang, onLang, onView, onPicker, onWorkspaces, onAgent }: Props) {
  const t = useT()
  return (
    <header className={`titlebar${drag.active ? ' is-dragging' : ''}${drag.over ? ' is-over' : ''}`}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <i className="is-working" />
          <i className="is-waiting" />
          <i />
        </span>
        <h1 className="brand-name">CLI Organizer</h1>
      </div>

      {drag.active ? (
        <p className="drop-hint" role="status">
          {dropHint(drag, t)}
        </p>
      ) : (
        <nav className="view-switch" aria-label={t.viewSwitch}>
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className="view-button"
              aria-pressed={view === v.id}
              onClick={() => {
                onView(v.id)
                // Also the active view: a click puts every dragged-out terminal back in its place.
                window.organizer.reseat()
              }}
              title={t.viewTitle(t.view[v.id], v.key)}
            >
              <Icon name={v.icon} />
              <span>{t.view[v.id]}</span>
            </button>
          ))}
        </nav>
      )}

      <div className="titlebar-actions">
        <button type="button" className="button is-quiet" onClick={onWorkspaces} disabled={!hasSessions && !workspace}>
          <Icon name="layers" />
          <span className="workspace-label">{workspace ? workspace.name : t.workspaces}</span>
        </button>
        <button
          type="button"
          className="button is-quiet"
          onClick={() => window.organizer.newInstance()}
          title={t.newInstanceTitle}
        >
          <Icon name="plus" />
          <span className="instance-label">{t.newInstance}</span>
        </button>
        <button type="button" className="button is-quiet" onClick={onAgent} title={t.agentStartTitle}>
          <Icon name="agent" />
          <span className="agent-label">{t.agentStart}</span>
        </button>
        <button type="button" className="button is-primary" onClick={onPicker}>
          <Icon name="capture" />
          <span>{t.capture}</span>
        </button>
      </div>

      <div className="lang-switch" role="radiogroup" aria-label={t.language}>
        {LANGS.map((l) => (
          <button key={l} type="button" role="radio" className="lang-button" aria-checked={lang === l} lang={l} onClick={() => onLang(l)}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="window-controls">
        <button type="button" className="window-button" onClick={() => window.organizer.windowControl('minimize')}>
          <Icon name="minimize" />
          <span className="sr-only">{t.minimize}</span>
        </button>
        <button type="button" className="window-button" onClick={() => window.organizer.windowControl('maximize')}>
          <Icon name="maximize" />
          <span className="sr-only">{t.maximize}</span>
        </button>
        <button type="button" className="window-button is-close" onClick={() => window.organizer.windowControl('close')}>
          <Icon name="close" />
          <span className="sr-only">{t.closeApp}</span>
        </button>
      </div>
    </header>
  )
}
