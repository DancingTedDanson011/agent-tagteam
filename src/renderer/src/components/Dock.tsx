import type { SessionInfo } from '../../../shared/types'
import { useT } from '../i18n'
import { ColorMark, displayTitle, StatusDot } from './SessionHeader'

export function Dock({ sessions, onRestore }: { sessions: SessionInfo[]; onRestore: (id: string) => void }) {
  const t = useT()
  if (sessions.length === 0) return null
  return (
    <nav className="dock" aria-label={t.dockLabel}>
      <span className="dock-label">{t.dock}</span>
      <ul className="dock-list">
        {sessions.map((s) => (
          <li key={s.id}>
            <button type="button" className={`dock-item${s.badge ? ' has-badge' : ''}`} onClick={() => onRestore(s.id)}>
              <StatusDot session={s} />
              <ColorMark session={s} />
              <span className="dock-title">{displayTitle(s)}</span>
              {s.badge && <span className="dock-badge">{t.dockWaits}</span>}
              <span className="sr-only">{t.dockRestore}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
