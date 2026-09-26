import { describe, expect, it } from 'vitest'
import { initialDrag, stepDrag, type DragInput, type DragMachine } from './drag'

const R = (left: number, top: number, w = 800, h = 500) => ({ left, top, right: left + w, bottom: top + h })

function run(inputs: DragInput[]) {
  let m: DragMachine = initialDrag()
  const emits: Array<{ active: boolean; over: boolean; kind?: string }> = []
  const drops: string[] = []
  for (const i of inputs) {
    const r = stepDrag(m, i)
    m = r.machine
    if (r.emit) emits.push(r.emit)
    if (r.drop) drops.push(r.drop)
  }
  return { m, emits, drops }
}

const fg = (id: string, rect = R(0, 0), eligible = true) => ({ id, rect, eligible })
const captured = (id: string, rect = R(0, 0)) => ({ id, rect, eligible: false, captured: true })

describe('dragging a captured window back', () => {
  it('a captured window dragged out and dropped over the app is put back (reseat), not captured again', () => {
    let m: DragMachine = initialDrag()
    const results = [
      { buttonDown: true, fg: captured('c1', R(0, 0)), cursorOverApp: false },
      { buttonDown: true, fg: captured('c1', R(60, 0)), cursorOverApp: false },
      { buttonDown: true, fg: captured('c1', R(300, 200)), cursorOverApp: true },
      { buttonDown: false, fg: captured('c1', R(300, 200)), cursorOverApp: true }
    ].map((i) => {
      const r = stepDrag(m, i)
      m = r.machine
      return r
    })
    expect(results[1].emit).toEqual({ active: true, over: false, kind: 'reseat' })
    expect(results[3].drop).toBe('c1')
    expect(results[3].dropKind).toBe('reseat')
  })

  it('a captured window dropped outside the app stays where the user put it', () => {
    const { drops } = run([
      { buttonDown: true, fg: captured('c1', R(0, 0)), cursorOverApp: true },
      { buttonDown: true, fg: captured('c1', R(900, 0)), cursorOverApp: false },
      { buttonDown: false, fg: captured('c1', R(900, 0)), cursorOverApp: false }
    ])
    expect(drops).toEqual([])
  })
})

describe('drag-in detection', () => {
  it('captures a console window dragged by its title bar and released over the app', () => {
    const { drops, emits } = run([
      { buttonDown: true, fg: fg('w1', R(0, 0)), cursorOverApp: false },
      { buttonDown: true, fg: fg('w1', R(40, 10)), cursorOverApp: false },
      { buttonDown: true, fg: fg('w1', R(300, 200)), cursorOverApp: true },
      { buttonDown: false, fg: fg('w1', R(300, 200)), cursorOverApp: true }
    ])
    expect(drops).toEqual(['w1'])
    expect(emits).toEqual([
      { active: true, over: false, kind: 'capture' },
      { active: true, over: true, kind: 'capture' },
      { active: false, over: false, kind: 'capture' }
    ])
  })

  it('does not capture when released outside the app', () => {
    const { drops } = run([
      { buttonDown: true, fg: fg('w1', R(0, 0)), cursorOverApp: false },
      { buttonDown: true, fg: fg('w1', R(50, 0)), cursorOverApp: true },
      { buttonDown: true, fg: fg('w1', R(900, 0)), cursorOverApp: false },
      { buttonDown: false, fg: fg('w1', R(900, 0)), cursorOverApp: false }
    ])
    expect(drops).toEqual([])
  })

  it('a click into the console (no movement) is not a drag', () => {
    const { drops, emits } = run([
      { buttonDown: true, fg: fg('w1'), cursorOverApp: true },
      { buttonDown: true, fg: fg('w1'), cursorOverApp: true },
      { buttonDown: false, fg: fg('w1'), cursorOverApp: true }
    ])
    expect(drops).toEqual([])
    expect(emits).toEqual([])
  })

  it('resizing a console over the app is not a drag-in', () => {
    const { drops } = run([
      { buttonDown: true, fg: fg('w1', R(0, 0, 800, 500)), cursorOverApp: true },
      { buttonDown: true, fg: fg('w1', R(0, 0, 900, 500)), cursorOverApp: true },
      { buttonDown: false, fg: fg('w1', R(0, 0, 900, 500)), cursorOverApp: true }
    ])
    expect(drops).toEqual([])
  })

  it('ignores windows that are not eligible (not a console, already captured, own window)', () => {
    const { drops } = run([
      { buttonDown: true, fg: fg('n1', R(0, 0), false), cursorOverApp: false },
      { buttonDown: true, fg: fg('n1', R(100, 0), false), cursorOverApp: true },
      { buttonDown: false, fg: fg('n1', R(100, 0), false), cursorOverApp: true }
    ])
    expect(drops).toEqual([])
  })

  it('a new press on another window starts a fresh baseline', () => {
    const { drops } = run([
      { buttonDown: true, fg: fg('w1', R(0, 0)), cursorOverApp: false },
      { buttonDown: true, fg: fg('w2', R(500, 0)), cursorOverApp: false },
      { buttonDown: true, fg: fg('w2', R(500, 0)), cursorOverApp: true },
      { buttonDown: false, fg: fg('w2', R(500, 0)), cursorOverApp: true }
    ])
    expect(drops).toEqual([])
  })

  it('keeps tracking the dragged window even if the foreground reading flickers', () => {
    const { drops } = run([
      { buttonDown: true, fg: fg('w1', R(0, 0)), cursorOverApp: false },
      { buttonDown: true, fg: fg('w1', R(20, 0)), cursorOverApp: false },
      { buttonDown: true, fg: null, cursorOverApp: true },
      { buttonDown: false, fg: null, cursorOverApp: true }
    ])
    expect(drops).toEqual(['w1'])
  })
})
