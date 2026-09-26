import type { CSSProperties, ReactNode } from 'react'
import type { SessionInfo } from '../../../shared/types'
import { displayTitle, SessionHeader } from '../components/SessionHeader'
import { slotRef } from '../layout-sync'
import { focusTerminal } from '../terminals'
import { TerminalBody } from './TerminalBody'

type Props = {
  session: SessionInfo
  onMinimize?: () => void
  onRelease: () => void
  onHeaderPointerDown?: (e: React.PointerEvent) => void
  onActivate?: () => void
  /** Keyboard focus entered the tile (free view: an overlapped tile must come to the front). */
  onFocusWithin?: () => void
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

/** A session shown for real: our header on top, the captured window positioned over the body. */
export function LiveTile({
  session,
  onMinimize,
  onRelease,
  onHeaderPointerDown,
  onActivate,
  onFocusWithin,
  className,
  style,
  children
}: Props) {
  return (
    <article
      className={`tile is-${session.activity}${session.badge ? ' has-badge' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      data-id={session.id}
      aria-label={displayTitle(session)}
      onFocus={onFocusWithin}
    >
      <SessionHeader
        session={session}
        onMinimize={onMinimize}
        onRelease={onRelease}
        onPointerDown={onHeaderPointerDown}
        onActivate={onActivate ?? (() => (session.agent ? focusTerminal(session.id) : window.organizer.focusSession(session.id)))}
      />
      {session.agent ? <TerminalBody id={session.id} /> : <div className="tile-body" ref={slotRef(session.id, 'live')} />}
      {children}
    </article>
  )
}
