import { describe, expect, it } from 'vitest'
import type { SessionInfo, Workspace } from '../../shared/types'
import { assignSlots, cleanTitle, missingSlots, workspaceFromState } from './workspaces'
import { initialState, reduce } from './model'

const s = (id: string, processName: string, title: string): SessionInfo => ({
  id,
  title,
  processName,
  className: 'X',
  alive: true,
  activity: 'idle',
  badge: false
})

const ws = (slots: Array<[string, string]>): Workspace => ({
  id: 'w',
  name: 'Test',
  view: 'grid',
  slots: slots.map(([processName, titleIncludes]) => ({ rule: { processName, titleIncludes } }))
})

describe('cleanTitle', () => {
  it('strips the Claude Code status glyph so the rule survives working/idle changes', () => {
    expect(cleanTitle('✳ HWM')).toBe('HWM')
    expect(cleanTitle('◐ HWM')).toBe('HWM')
    expect(cleanTitle('  plain title ')).toBe('plain title')
  })
})

describe('assignSlots', () => {
  it('matches by process and title first', () => {
    const map = assignSlots(ws([['WindowsTerminal.exe', 'HWM'], ['cmd.exe', 'server']]), [
      s('1', 'cmd.exe', 'node server.js'),
      s('2', 'WindowsTerminal.exe', '✳ HWM')
    ])
    expect(map).toEqual(new Map([['2', 0], ['1', 1]]))
  })

  it('process names compare case-insensitively', () => {
    const map = assignSlots(ws([['windowsterminal.EXE', 'HWM']]), [s('1', 'WindowsTerminal.exe', 'HWM')])
    expect(map.get('1')).toBe(0)
  })

  it('fills free slots in order when no rule matches (all WT windows share one process)', () => {
    const map = assignSlots(ws([['WindowsTerminal.exe', 'old topic A'], ['WindowsTerminal.exe', 'old topic B']]), [
      s('1', 'WindowsTerminal.exe', 'new topic'),
      s('2', 'WindowsTerminal.exe', 'other')
    ])
    expect(map).toEqual(new Map([['1', 0], ['2', 1]]))
  })

  it('never gives one slot to two sessions and leaves extra sessions unassigned', () => {
    const map = assignSlots(ws([['WindowsTerminal.exe', 'HWM']]), [
      s('1', 'WindowsTerminal.exe', 'HWM'),
      s('2', 'WindowsTerminal.exe', 'HWM')
    ])
    expect(map).toEqual(new Map([['1', 0]]))
  })

  it('an empty title rule matches any title of that process', () => {
    const map = assignSlots(ws([['cmd.exe', '']]), [s('1', 'cmd.exe', 'whatever')])
    expect(map.get('1')).toBe(0)
  })
})

describe('workspaceFromState', () => {
  it('records view, order, rules and free rects', () => {
    let st = reduce(initialState(), {
      type: 'sessions',
      list: [s('1', 'cmd.exe', '✳ build'), s('2', 'WindowsTerminal.exe', 'HWM')]
    })
    st = reduce(st, { type: 'reorder', order: ['2', '1'] })
    st = reduce(st, { type: 'view', view: 'free' })
    st = reduce(st, { type: 'moveFree', id: '1', rect: { x: 5, y: 6, width: 400, height: 300 } })
    const w = workspaceFromState(st, 'Dev', 'id1')
    expect(w).toEqual({
      id: 'id1',
      name: 'Dev',
      view: 'free',
      slots: [
        { rule: { processName: 'WindowsTerminal.exe', titleIncludes: 'HWM' } },
        { rule: { processName: 'cmd.exe', titleIncludes: 'build' }, free: { x: 5, y: 6, width: 400, height: 300 } }
      ]
    })
  })
})

describe('applying a workspace', () => {
  it('sets the view, orders sessions by slot and restores free rects', () => {
    let st = reduce(initialState(), {
      type: 'sessions',
      list: [s('1', 'cmd.exe', 'build'), s('2', 'WindowsTerminal.exe', 'HWM'), s('3', 'pwsh.exe', 'x')]
    })
    const w: Workspace = {
      id: 'w',
      name: 'Dev',
      view: 'free',
      slots: [
        { rule: { processName: 'WindowsTerminal.exe', titleIncludes: 'HWM' }, free: { x: 1, y: 1, width: 300, height: 200 } },
        { rule: { processName: 'cmd.exe', titleIncludes: 'build' } }
      ]
    }
    st = reduce(st, { type: 'applyWorkspace', workspace: w })
    expect(st.view).toBe('free')
    expect(st.order).toEqual(['2', '1', '3'])
    expect(st.free['2']).toEqual({ x: 1, y: 1, width: 300, height: 200 })
    expect(st.workspaceId).toBe('w')
  })
})

describe('names, colours and recipes', () => {
  const styled = (id: string, processName: string, title: string, label?: string): SessionInfo => ({ ...s(id, processName, title), ...(label ? { label, color: 'blue' as const } : {}) })
  const recipe = { kind: 'window' as const, host: 'wt' as const, cwd: 'C:\\work' }

  it('the saved name finds its session even after the title changed', () => {
    const w: Workspace = { id: 'w', name: 'T', view: 'grid', slots: [{ rule: { processName: 'WindowsTerminal.exe', titleIncludes: 'old' }, label: 'Build', launch: recipe }] }
    expect(assignSlots(w, [styled('1', 'WindowsTerminal.exe', 'other'), styled('2', 'WindowsTerminal.exe', 'new', 'Build')])).toEqual(new Map([['2', 0]]))
  })

  it('a named slot takes only the session with that name, not another window with the same title (selftest, 2026-09-25)', () => {
    const w: Workspace = { id: 'w', name: 'T', view: 'grid', slots: [{ rule: { processName: 'cmd.exe', titleIncludes: 'clio' }, label: 'Build', launch: recipe }] }
    const sessions = [styled('1', 'cmd.exe', 'clio')]
    expect(assignSlots(w, sessions)).toEqual(new Map())
    expect(missingSlots(w, sessions)).toEqual([0])
  })

  it('a slot that can restore its window is not filled with an unrelated session; it counts as missing', () => {
    const w: Workspace = { id: 'w', name: 'T', view: 'grid', slots: [{ rule: { processName: 'WindowsTerminal.exe', titleIncludes: 'BMD' }, launch: recipe }, { rule: { processName: 'cmd.exe', titleIncludes: '' } }] }
    const sessions = [styled('1', 'WindowsTerminal.exe', 'unrelated'), styled('2', 'cmd.exe', 'x')]
    expect(assignSlots(w, sessions)).toEqual(new Map([['2', 1]]))
    expect(missingSlots(w, sessions)).toEqual([0])
  })

  it('saving records name, colour, recipe and the resume choice', () => {
    const st = reduce(initialState(), { type: 'sessions', list: [styled('1', 'cmd.exe', 'b', 'Build'), s('2', 'mintty.exe', 'x')] })
    const w = workspaceFromState(st, 'Dev', 'id1', { '1': { kind: 'window', host: 'conhost', shell: 'cmd', cwd: 'C:\\w' }, '2': null }, true)
    expect(w).toEqual({
      id: 'id1',
      name: 'Dev',
      view: 'focus',
      resume: true,
      slots: [
        { rule: { processName: 'cmd.exe', titleIncludes: 'b' }, label: 'Build', color: 'blue', launch: { kind: 'window', host: 'conhost', shell: 'cmd', cwd: 'C:\\w' } },
        { rule: { processName: 'mintty.exe', titleIncludes: 'x' } }
      ]
    })
  })
})

describe('a restored window lands in its slot', () => {
  const w: Workspace = {
    id: 'w',
    name: 'Dev',
    view: 'free',
    slots: [
      { rule: { processName: 'cmd.exe', titleIncludes: '' }, launch: { kind: 'window', host: 'conhost', shell: 'cmd', cwd: null }, free: { x: 9, y: 9, width: 500, height: 300 } },
      { rule: { processName: 'pwsh.exe', titleIncludes: 'p' } }
    ]
  }
  it('also when the capture shows up in the session list only afterwards', () => {
    let st = reduce(initialState(), { type: 'workspaces', list: [w] })
    st = reduce(st, { type: 'sessions', list: [s('7', 'pwsh.exe', 'p'), s('8', 'other.exe', 'o')] })
    st = reduce(st, { type: 'applyWorkspace', workspace: w })
    expect(st.order).toEqual(['7', '8'])
    st = reduce(st, { type: 'slotCaptured', id: '9', slot: 0, workspaceId: 'w' })
    st = reduce(st, { type: 'sessions', list: [s('7', 'pwsh.exe', 'p'), s('8', 'other.exe', 'o'), s('9', 'cmd.exe', 'c')] })
    expect(st.order).toEqual(['9', '7', '8'])
    expect(st.free['9']).toEqual({ x: 9, y: 9, width: 500, height: 300 })
  })
  it('a restored session that closed is forgotten: a later window with the same id is not moved (cold review)', () => {
    let st = reduce(initialState(), { type: 'workspaces', list: [w] })
    st = reduce(st, { type: 'applyWorkspace', workspace: w })
    st = reduce(st, { type: 'slotCaptured', id: '9', slot: 0, workspaceId: 'w' })
    st = reduce(st, { type: 'sessions', list: [s('9', 'cmd.exe', 'c')] })
    st = reduce(st, { type: 'sessions', list: [] })
    expect(st.restoredSlots).toEqual({})
  })
  it('a late capture of a workspace applied before another one is ignored (cold review)', () => {
    const w2: Workspace = { ...w, id: 'w2', slots: [{ rule: { processName: 'x.exe', titleIncludes: '' }, free: { x: 500, y: 500, width: 10, height: 10 } }] }
    let st = reduce(initialState(), { type: 'workspaces', list: [w, w2] })
    st = reduce(st, { type: 'applyWorkspace', workspace: w })
    st = reduce(st, { type: 'applyWorkspace', workspace: w2 })
    st = reduce(st, { type: 'slotCaptured', id: '9', slot: 0, workspaceId: 'w' })
    st = reduce(st, { type: 'sessions', list: [s('9', 'cmd.exe', 'c')] })
    expect(st.free['9']).toBeUndefined()
    expect(st.restoredSlots).toEqual({})
  })
  it('and when it is already listed', () => {
    let st = reduce(initialState(), { type: 'workspaces', list: [w] })
    st = reduce(st, { type: 'sessions', list: [s('7', 'pwsh.exe', 'p')] })
    st = reduce(st, { type: 'applyWorkspace', workspace: w })
    st = reduce(st, { type: 'sessions', list: [s('7', 'pwsh.exe', 'p'), s('9', 'cmd.exe', 'c')] })
    expect(st.order).toEqual(['7', '9'])
    st = reduce(st, { type: 'slotCaptured', id: '9', slot: 0, workspaceId: 'w' })
    expect(st.order).toEqual(['9', '7'])
    expect(st.free['9']).toEqual({ x: 9, y: 9, width: 500, height: 300 })
  })
})
