import { useEffect, useRef, useState } from 'react'
import { gridDims } from '../../../shared/geometry'
import type { SessionInfo } from '../../../shared/types'
import { LiveTile } from './LiveTile'

type Props = { sessions: SessionInfo[]; onMinimize: (id: string) => void; onRelease: (id: string) => void }

export function GridView({ sessions, onMinimize, onRelease }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1200, height: 800 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setSize({ width: r.width, height: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { cols, rows } = gridDims(sessions.length, size.width, size.height)
  return (
    <div
      ref={ref}
      className="grid-view"
      style={{ gridTemplateColumns: `repeat(${cols || 1}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows || 1}, minmax(0, 1fr))` }}
    >
      {sessions.map((s) => (
        <LiveTile key={s.id} session={s} onMinimize={() => onMinimize(s.id)} onRelease={() => onRelease(s.id)} />
      ))}
    </div>
  )
}
