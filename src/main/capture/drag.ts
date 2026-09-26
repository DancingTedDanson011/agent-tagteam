// Detects "a console window is being dragged by its title bar and dropped onto the app" from
// polled input (mouse button, foreground window, its rect, cursor position). Polling instead of a
// WinEvent hook keeps this independent of which thread pumps messages.
//  capture — an uncaptured console window is dropped onto the app: capture it
//  reseat  — a captured window (dragged out by its own tab bar) is dropped back: put it back in its slot
import { moved, type WinRect } from '../../shared/geometry'
import type { DragKind, DragState } from '../../shared/types'

export type DragInput = {
  buttonDown: boolean
  /**
   * The foreground window. eligible = an uncaptured console window that is not the app itself;
   * captured = a window this app has captured.
   */
  fg: { id: string; rect: WinRect; eligible: boolean; captured?: boolean } | null
  cursorOverApp: boolean
}

export type DragMachine = {
  press: { id: string; rect: WinRect; kind: DragKind } | null
  dragging: string | null
  kind: DragKind
  over: boolean
}

export function initialDrag(): DragMachine {
  return { press: null, dragging: null, kind: 'capture', over: false }
}

export function stepDrag(
  m: DragMachine,
  input: DragInput
): { machine: DragMachine; emit?: DragState; drop?: string; dropKind?: DragKind } {
  if (m.dragging) {
    if (!input.buttonDown) {
      const dropped = input.cursorOverApp ? m.dragging : undefined
      return {
        machine: initialDrag(),
        emit: { active: false, over: false, kind: m.kind },
        drop: dropped,
        dropKind: dropped ? m.kind : undefined
      }
    }
    if (input.cursorOverApp !== m.over) {
      return { machine: { ...m, over: input.cursorOverApp }, emit: { active: true, over: input.cursorOverApp, kind: m.kind } }
    }
    return { machine: m }
  }

  const fg = input.fg
  const kind: DragKind | null = !fg ? null : fg.eligible ? 'capture' : fg.captured ? 'reseat' : null
  if (!input.buttonDown || !fg || !kind) {
    return { machine: input.buttonDown ? m : initialDrag() }
  }
  if (!m.press || m.press.id !== fg.id) return { machine: { ...m, press: { id: fg.id, rect: fg.rect, kind } } }
  if (moved(m.press.rect, fg.rect)) {
    return {
      machine: { press: null, dragging: fg.id, kind: m.press.kind, over: input.cursorOverApp },
      emit: { active: true, over: input.cursorOverApp, kind: m.press.kind }
    }
  }
  return { machine: m }
}
