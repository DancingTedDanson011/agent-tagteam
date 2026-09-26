// INTENTIONAL-UNTESTED: presentational; covered by the in-app selftest (focus view side card) and the
// Playwright preview probe, which checks the scaled card shows the screen's text.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { onOutput, screenLines } from '../terminals'

const REFRESH_MS = 400

/**
 * The small card of an agent tile: the WHOLE visible screen, scaled down to the card like the live
 * thumbnails of captured windows (showing the last lines at text size read as "zoomed in").
 */
export function AgentPreview({ id }: { id: string }) {
  const [screen, setScreen] = useState(() => screenLines(id))
  const box = useRef<HTMLSpanElement>(null)
  const pre = useRef<HTMLPreElement>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    // INTENTIONAL-UNTESTED: read again once subscribed (pinned by the Playwright preview probe):
    // output parsed between the first render and this subscription signalled nobody (card stayed empty).
    setScreen(screenLines(id))
    const off = onOutput(id, () => {
      timer ??= setTimeout(() => {
        timer = null
        setScreen(screenLines(id))
      }, REFRESH_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [id])

  // Scale the full-size screen text down to the card's width.
  useLayoutEffect(() => {
    const b = box.current
    const p = pre.current
    if (!b || !p) return
    const fit = () => {
      const scale = p.scrollWidth > 0 ? b.clientWidth / p.scrollWidth : 1
      p.style.transform = `scale(${Math.min(1, scale)})`
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(b)
    return () => ro.disconnect()
  }, [screen.cols])

  return (
    <span className="side-text" ref={box} aria-hidden="true">
      <pre ref={pre} style={{ width: `${screen.cols}ch` }}>
        {screen.lines.join('\n')}
      </pre>
    </span>
  )
}
