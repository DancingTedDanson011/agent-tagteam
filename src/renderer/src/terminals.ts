// INTENTIONAL-UNTESTED: thin glue around xterm.js in the DOM (no DOM test dependency); pinned end to
// end by the in-app selftest, which types into an agent tile, selects and copies, in every view.
//
// One xterm per agent tile, created once and kept for the tile's lifetime. Views come and go; a tile
// only moves the terminal's DOM node into its body, so scrollback and cursor survive a view switch.
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { parseClipboardText, sanitizePaste } from '../../shared/folder'

type Entry = { term: Terminal; fit: FitAddon; host: HTMLDivElement; opened: boolean; listeners: Set<() => void> }

const entries = new Map<string, Entry>()
let subscribed = false

const THEME = {
  background: '#0b0e13',
  foreground: '#e7edf5',
  cursor: '#ffd166', // the focus colour: a cursor you find at a glance
  cursorAccent: '#0b0e13',
  selectionBackground: '#3a4a63'
}

/** True when the key/click was a copy. A selection over the clipboard limit is not copied and stays marked. */
const copy = (e: Entry) => {
  const text = e.term.getSelection()
  if (!text) return false
  if (parseClipboardText(text) === null) return true
  window.organizer.clipboardWrite(text)
  e.term.clearSelection()
  return true
}
const paste = (e: Entry) =>
  void window.organizer.clipboardRead().then((text) => {
    const clean = sanitizePaste(text)
    if (clean) e.term.paste(clean)
  })

function entry(id: string): Entry {
  let e = entries.get(id)
  if (e) return e
  const term = new Terminal({
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
    fontSize: 13,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'outline',
    scrollback: 5000,
    theme: THEME,
    allowProposedApi: false
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const host = document.createElement('div')
  host.className = 'term-host'
  term.onData((data) => window.organizer.agentInput(id, data))
  const created: Entry = { term, fit, host, opened: false, listeners: new Set() }
  // Copy and paste like Windows Terminal: Ctrl+C copies when something is selected (else it is the
  // usual interrupt), Ctrl+Shift+C/V always, Ctrl+V pastes; right click copies a selection or pastes.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey || ev.altKey) return true
    const key = ev.key.toLowerCase()
    if (key === 'c' && (ev.shiftKey || term.hasSelection())) return !(copy(created) || ev.shiftKey)
    if (key === 'v') {
      ev.preventDefault()
      paste(created)
      return false
    }
    return true
  })
  host.addEventListener(
    'contextmenu',
    (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      if (!copy(created)) paste(created)
    },
    true
  )
  entries.set(id, created)
  return created
}

/** Starts listening to terminal output once, for all agent tiles (also the ones not on screen). */
export function listenToAgents(): () => void {
  if (subscribed) return () => undefined
  subscribed = true
  const off = window.organizer.onAgentData(({ id, data }) => {
    if (removed.has(id)) return // late output of a removed tile must not bring its terminal back
    const e = entry(id)
    e.term.write(data, () => e.listeners.forEach((l) => l()))
  })
  return () => {
    subscribed = false
    off()
  }
}

/** Shows the terminal inside `container` and sizes it to fit; returns the cleanup. */
export function attach(id: string, container: HTMLElement): () => void {
  const e = entry(id)
  container.appendChild(e.host)
  if (!e.opened) {
    e.term.open(e.host)
    e.opened = true
  }
  const refit = () => {
    if (container.clientWidth < 20 || container.clientHeight < 20) return
    const before = `${e.term.cols}x${e.term.rows}`
    try {
      e.fit.fit()
    } catch {
      return // not laid out yet
    }
    if (`${e.term.cols}x${e.term.rows}` !== before) window.organizer.agentResize(id, e.term.cols, e.term.rows)
  }
  const ro = new ResizeObserver(refit)
  ro.observe(container)
  refit()
  // The cell size is measured with the font that is loaded at that moment; measure again once the
  // real font is there (a fallback font's cells left rows outside the tile).
  void document.fonts.ready.then(refit)
  return () => {
    ro.disconnect()
    if (e.host.parentElement === container) container.removeChild(e.host)
  }
}

export function focusTerminal(id: string): void {
  entries.get(id)?.term.focus()
}

/** The program inside wants the mouse (e.g. Claude Code): a plain drag goes to it, Shift+drag selects. */
export function wantsMouse(id: string): boolean {
  return (entries.get(id)?.term.modes.mouseTrackingMode ?? 'none') !== 'none'
}

/** The visible screen, row by row, and its width in columns (the small cards draw it scaled down). */
export function screenLines(id: string): { lines: string[]; cols: number } {
  const e = entries.get(id)
  if (!e) return { lines: [], cols: 80 }
  const buf = e.term.buffer.active
  const lines: string[] = []
  for (let y = buf.viewportY; y < buf.viewportY + e.term.rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return { lines, cols: e.term.cols }
}

/** Called after new output was drawn; returns the unsubscribe. */
export function onOutput(id: string, cb: () => void): () => void {
  const e = entry(id)
  e.listeners.add(cb)
  return () => e.listeners.delete(cb)
}

/**
 * Forget the terminals of tiles that WERE listed and are gone. Only those: output can arrive before
 * the session list names a new tile, and dropping "everything not listed" wiped such a terminal.
 */
const listed = new Set<string>()
// Agent ids are never reused (main counts up), so a removed id can be ignored for good.
const removed = new Set<string>()
export function syncListed(ids: Set<string>): void {
  for (const id of listed) {
    if (ids.has(id)) continue
    const e = entries.get(id)
    e?.term.dispose()
    e?.host.remove()
    entries.delete(id)
    listed.delete(id)
    removed.add(id)
  }
  for (const id of ids) listed.add(id)
}
