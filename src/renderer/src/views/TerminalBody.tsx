// INTENTIONAL-UNTESTED: DOM mount point for an agent terminal (see terminals.ts); covered by the
// in-app selftest in every view.
import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { attach, focusTerminal, onOutput, wantsMouse } from '../terminals'

/** The body of an agent tile: its live terminal, sized to the tile. */
export function TerminalBody({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const t = useT()
  const [mouse, setMouse] = useState(() => wantsMouse(id))
  useEffect(() => (ref.current ? attach(id, ref.current) : undefined), [id])
  // When the program takes the mouse (Claude Code does), a plain drag no longer selects: say how.
  useEffect(() => onOutput(id, () => setMouse(wantsMouse(id))), [id])
  return (
    <div className="tile-body term-body" ref={ref} onMouseDown={() => focusTerminal(id)}>
      {mouse && <span className="term-hint">{t.selectHint}</span>}
    </div>
  )
}
