import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../../shared/types'
import { initialState, mergeSubOrder, moveInList, reduce, roles, type UiState } from './model'

describe('mergeSubOrder', () => {
  it('reorders only the given subset and keeps everything else in place', () => {
    // big session 'b' at index 1, docked 'd' at the end; the side list is a, c, e
    expect(mergeSubOrder(['a', 'b', 'c', 'e', 'd'], ['e', 'a', 'c'])).toEqual(['e', 'b', 'a', 'c', 'd'])
  })
  it('ignores ids that are not part of the order', () => {
    expect(mergeSubOrder(['a', 'b', 'c'], ['c', 'x', 'a'])).toEqual(['c', 'b', 'a'])
  })
  it('keeps the order when the subset is not a permutation of order members', () => {
    expect(mergeSubOrder(['a', 'b', 'c'], ['a'])).toEqual(['a', 'b', 'c'])
  })
})

describe('moveInList', () => {
  it('moves an item up and down, clamped at the ends', () => {
    expect(moveInList(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveInList(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveInList(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
    expect(moveInList(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
  })
  it('moves to an absolute index', () => {
    expect(moveInList(['a', 'b', 'c', 'd'], 'a', 2, true)).toEqual(['b', 'c', 'a', 'd'])
  })
})

const s = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: `t-${id}`,
  className: 'CASCADIA_HOSTING_WINDOW_CLASS',
  processName: 'WindowsTerminal.exe',
  alive: true,
  activity: 'idle',
  badge: false,
  ...extra
})

const withSessions = (ids: string[], base: UiState = initialState()) =>
  reduce(base, { type: 'sessions', list: ids.map((id) => s(id)) })

describe('session list updates', () => {
  it('appends new sessions in arrival order and keeps the user order for known ones', () => {
    let st = withSessions(['a', 'b'])
    st = reduce(st, { type: 'reorder', order: ['b', 'a'] })
    st = withSessions(['a', 'b', 'c'], st)
    expect(st.order).toEqual(['b', 'a', 'c'])
  })

  it('forgets removed sessions everywhere (order, dock, free rects, focus, tab)', () => {
    let st = withSessions(['a', 'b'])
    st = reduce(st, { type: 'minimize', id: 'a' })
    st = reduce(st, { type: 'moveFree', id: 'a', rect: { x: 1, y: 2, width: 300, height: 200 } })
    st = reduce(st, { type: 'focus', id: 'b' })
    st = withSessions(['a'], st)
    st = withSessions([], st)
    expect(st.order).toEqual([])
    expect(st.minimized).toEqual([])
    expect(st.free).toEqual({})
    expect(st.focusId).toBeNull()
  })

  it('picks a new focus when the focused session disappears', () => {
    let st = withSessions(['a', 'b'])
    st = reduce(st, { type: 'focus', id: 'a' })
    st = withSessions(['b'], st)
    expect(st.focusId).toBe('b')
  })

  it('a freshly captured session becomes the focus', () => {
    let st = withSessions(['a'])
    st = reduce(st, { type: 'captured', id: 'b' })
    st = withSessions(['a', 'b'], st)
    expect(st.focusId).toBe('b')
  })
})

describe('roles per view', () => {
  it('cockpit parks every native window, including docked sessions, without attending any terminal', () => {
    let st = withSessions(['a', 'b', 'c'])
    st = reduce(st, { type: 'minimize', id: 'b' })
    st = reduce(st, { type: 'view', view: 'cockpit' })
    expect(roles(st)).toEqual({ live: [], thumb: [], parked: ['a', 'b', 'c'], attended: [] })
  })

  it('free and grid: every visible session is live, docked ones are parked', () => {
    let st = withSessions(['a', 'b', 'c'])
    st = reduce(st, { type: 'minimize', id: 'b' })
    for (const view of ['free', 'grid'] as const) {
      const r = roles(reduce(st, { type: 'view', view }))
      expect(r.live).toEqual(['a', 'c'])
      expect(r.thumb).toEqual([])
      expect(r.parked).toEqual(['b'])
      expect(r.attended).toEqual([])
    }
  })

  it('focus: one live session, the others as live thumbnails, and the big one is attended', () => {
    let st = withSessions(['a', 'b', 'c'])
    st = reduce(st, { type: 'view', view: 'focus' })
    st = reduce(st, { type: 'focus', id: 'b' })
    expect(roles(st)).toEqual({ live: ['b'], thumb: ['a', 'c'], parked: [], attended: ['b'] })
  })

  it('tabs: only the active tab is live', () => {
    let st = withSessions(['a', 'b', 'c'])
    st = reduce(st, { type: 'view', view: 'tabs' })
    st = reduce(st, { type: 'focus', id: 'c' })
    expect(roles(st)).toEqual({ live: ['c'], thumb: [], parked: ['a', 'b'], attended: ['c'] })
  })

  it('an open dialog parks everything, because real windows would cover it', () => {
    let st = withSessions(['a', 'b'])
    st = reduce(st, { type: 'view', view: 'focus' })
    st = reduce(st, { type: 'modal', modal: 'picker' })
    expect(roles(st)).toEqual({ live: [], thumb: [], parked: ['a', 'b'], attended: [] })
  })

  it('focusing a docked session brings it back from the dock', () => {
    let st = withSessions(['a', 'b'])
    st = reduce(st, { type: 'minimize', id: 'a' })
    st = reduce(st, { type: 'focus', id: 'a' })
    expect(st.minimized).toEqual([])
    expect(st.focusId).toBe('a')
  })

  it('minimizing the focused session moves focus to the next visible one', () => {
    let st = withSessions(['a', 'b'])
    st = reduce(st, { type: 'view', view: 'focus' })
    st = reduce(st, { type: 'focus', id: 'a' })
    st = reduce(st, { type: 'minimize', id: 'a' })
    expect(st.focusId).toBe('b')
    expect(roles(st).live).toEqual(['b'])
  })

  it('with everything docked nothing is live', () => {
    let st = withSessions(['a'])
    st = reduce(st, { type: 'view', view: 'focus' })
    st = reduce(st, { type: 'minimize', id: 'a' })
    expect(roles(st)).toEqual({ live: [], thumb: [], parked: ['a'], attended: [] })
  })
})
