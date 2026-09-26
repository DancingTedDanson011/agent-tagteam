// INTENTIONAL-UNTESTED: presentational component without a unit harness (no DOM test dependency);
// its buttons are exercised by the in-app selftest (minimize, release, bring back) and measured by
// the design-beweis probe.
import { useEffect, useState } from 'react'
import { COLORS } from '../../../shared/restore'
import type { SessionInfo } from '../../../shared/types'
import { useT } from '../i18n'
import { cleanTitle } from '../workspaces'
import { Icon } from './Icon'
import { useOpenStyle } from './StyleDialog'

export function StatusDot({ session }: { session: SessionInfo }) {
  return <span className={`status-dot is-${session.activity}`} aria-hidden="true" />
}

export function displayTitle(s: SessionInfo): string {
  return s.label || cleanTitle(s.title) || s.processName
}

/** The session's colour as a small mark next to its name (nothing when it has none). */
export function ColorMark({ session }: { session: SessionInfo }) {
  if (!session.color) return null
  return <span className="color-mark" style={{ background: COLORS[session.color] }} aria-hidden="true" />
}

/** Inline style that hands the session colour to CSS (header stripe, card edge). */
export function colorVar(s: SessionInfo): React.CSSProperties | undefined {
  return s.color ? ({ '--session-color': COLORS[s.color] } as React.CSSProperties) : undefined
}

export function Badge({ session }: { session: SessionInfo }) {
  const t = useT()
  if (!session.badge) return null
  return (
    <span className="badge" role="status">
      <span className="badge-dot" aria-hidden="true" />
      {t.waitsForYou}
    </span>
  )
}

type Props = {
  session: SessionInfo
  onMinimize?: () => void
  onRelease: () => void
  onPointerDown?: (e: React.PointerEvent) => void
  /** The title button brings the terminal to the front with keyboard focus. */
  onActivate?: () => void
}

/** Header bar above a live session: status, name, actions. Drag handle in free view. */
export function SessionHeader({ session, onMinimize, onRelease, onPointerDown, onActivate }: Props) {
  const name = displayTitle(session)
  const t = useT()
  const openStyle = useOpenStyle()
  return (
    <div className={`session-header is-${session.activity}${session.color ? ' has-color' : ''}`} style={colorVar(session)} onPointerDown={onPointerDown}>
      <StatusDot session={session} />
      <button
        type="button"
        className="icon-button style-button"
        onClick={() => openStyle(session.id)}
        onPointerDown={(e) => e.stopPropagation()}
        title={t.styleButton(name)}
      >
        <span className={`style-chip${session.color ? '' : ' is-empty'}`} style={session.color ? { background: COLORS[session.color] } : undefined} aria-hidden="true" />
        <span className="sr-only">{t.styleButton(name)}</span>
      </button>
      <button type="button" className="session-name" onClick={onActivate} onDoubleClick={() => openStyle(session.id)} title={t.toFront}>
        <span className="session-title">{name}</span>
        <span className="session-meta">
          {session.agent ? t.agentProvider[session.agent.provider] : session.processName} ·{' '}
          {session.agent?.exited ? t.agentExited : session.displaced ? t.displaced : t.activity[session.activity]}
        </span>
      </button>
      {session.agent?.role === 'orchestrator' && <span className="chip is-orchestrator">{t.agentOrchestrator}</span>}
      {session.agent?.role === 'worker' && <span className="chip">{t.agentWorker}</span>}
      {session.agent?.asksTrust && (
        <span className="chip is-attention" role="status">
          {t.asksTrust}
        </span>
      )}
      <Badge session={session} />
      <div className="session-actions">
        {session.agent?.role === 'plain' && !session.agent.exited && (
          <button
            type="button"
            className="button is-quiet is-compact unlock-button"
            aria-pressed={session.agent.unlocked}
            onClick={() => window.organizer.unlockAgent(session.id, !session.agent?.unlocked)}
            title={t.agentUnlockHint}
          >
            {session.agent.unlocked ? t.agentUnlocked : t.agentUnlock}
          </button>
        )}
        {session.displaced && (
          <button
            type="button"
            className="button is-quiet is-compact"
            onClick={() => window.organizer.reseat([session.id])}
            title={t.bringBackTitle}
          >
            {t.bringBack}
          </button>
        )}
        {onMinimize && (
          <button type="button" className="icon-button" onClick={onMinimize} title={t.toDockTitle}>
            <Icon name="minimize" />
            <span className="sr-only">{t.toDock(name)}</span>
          </button>
        )}
        {session.agent ? (
          <AgentEndButton id={session.id} exited={session.agent.exited} name={name} />
        ) : (
          <button type="button" className="icon-button" onClick={onRelease} title={t.releaseTitle}>
            <Icon name="release" />
            <span className="sr-only">{t.release(name)}</span>
          </button>
        )}
      </div>
    </div>
  )
}

/** Stop a running agent (asks once more: its work ends), or close the tile of an ended one. */
function AgentEndButton({ id, exited, name }: { id: string; exited: boolean; name: string }) {
  const t = useT()
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(timer)
  }, [armed])
  if (exited) {
    return (
      <button type="button" className="icon-button" onClick={() => window.organizer.removeAgent(id)} title={t.agentClose(name)}>
        <Icon name="close" />
        <span className="sr-only">{t.agentClose(name)}</span>
      </button>
    )
  }
  return armed ? (
    <button type="button" className="button is-quiet is-compact is-danger" onClick={() => window.organizer.stopAgent(id)}>
      {t.agentStopConfirm}
    </button>
  ) : (
    <button type="button" className="icon-button" onClick={() => setArmed(true)} title={t.agentStop}>
      <Icon name="stop" />
      <span className="sr-only">{`${t.agentStop}: ${name}`}</span>
    </button>
  )
}
