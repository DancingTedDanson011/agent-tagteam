import type { KeyboardEvent } from 'react'
import type { SessionInfo } from '../../../shared/types'
import { ColorMark, displayTitle, StatusDot } from '../components/SessionHeader'
import { useT } from '../i18n'
import { LiveTile } from './LiveTile'

type Props = {
  sessions: SessionInfo[]
  activeId: string | null
  onSelect: (id: string) => void
  onMinimize: (id: string) => void
  onRelease: (id: string) => void
}

export function TabsView({ sessions, activeId, onSelect, onMinimize, onRelease }: Props) {
  const t = useT()
  const active = sessions.find((s) => s.id === activeId) ?? null

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const i = sessions.findIndex((s) => s.id === activeId)
    const next = sessions[(i + (e.key === 'ArrowRight' ? 1 : -1) + sessions.length) % sessions.length]
    if (next) {
      onSelect(next.id)
      document.getElementById(`tab-${next.id}`)?.focus()
    }
  }

  return (
    <div className="tabs-view">
      <div className="tab-bar" role="tablist" aria-label={t.tabsLabel} onKeyDown={onKey}>
        {sessions.map((s) => (
          <button
            key={s.id}
            id={`tab-${s.id}`}
            type="button"
            role="tab"
            aria-selected={s.id === activeId}
            aria-controls="tab-panel"
            tabIndex={s.id === activeId ? 0 : -1}
            className={`tab${s.badge ? ' has-badge' : ''}`}
            onClick={() => onSelect(s.id)}
          >
            <StatusDot session={s} />
            <ColorMark session={s} />
            <span className="tab-title">{displayTitle(s)}</span>
            {s.badge && (
              <span className="tab-badge">
                <span className="sr-only">{t.waitsForYouShort}</span>
              </span>
            )}
          </button>
        ))}
      </div>
      <div id="tab-panel" role="tabpanel" className="tab-panel" aria-labelledby={active ? `tab-${active.id}` : undefined}>
        {active && (
          <LiveTile session={active} onMinimize={() => onMinimize(active.id)} onRelease={() => onRelease(active.id)} />
        )}
      </div>
    </div>
  )
}
