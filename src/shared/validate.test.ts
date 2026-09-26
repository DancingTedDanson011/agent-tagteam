import { describe, expect, it } from 'vitest'
import { parseAgentId, parseAgentStart, parseId, parseIdList, parseLang, parseLayout, parseSessionId, parseTerminalSize, parseWorkspaces } from './validate'

describe('parseLayout: clip and modal', () => {
  it('keeps a valid clip on a thumbnail and the modal flag', () => {
    const layout = {
      placements: [{ id: '2', mode: 'thumb', rect: { x: 1, y: 2, width: 3, height: 4 }, clip: { x: 0, y: 50, width: 300, height: 600 } }],
      attended: [],
      modal: true
    }
    expect(parseLayout(layout)).toEqual(layout)
  })
  it('rejects a malformed clip and a non-boolean modal', () => {
    expect(parseLayout({ placements: [{ id: '2', mode: 'thumb', rect: { x: 1, y: 2, width: 3, height: 4 }, clip: { x: 'a' } }], attended: [] })).toBeNull()
    expect(parseLayout({ placements: [], attended: [], modal: 'yes' })).toBeNull()
  })
})

describe('parseIdList', () => {
  it('accepts a list of window ids', () => {
    expect(parseIdList(['1', '22'])).toEqual(['1', '22'])
  })
  it('rejects anything with a bad id, non-arrays and oversized lists', () => {
    expect(parseIdList(['1', 'x'])).toBeNull()
    expect(parseIdList('1')).toBeNull()
    expect(parseIdList(Array.from({ length: 1001 }, (_, i) => String(i + 1)))).toBeNull()
  })
})

describe('parseId', () => {
  it('accepts decimal window handles', () => {
    expect(parseId('657166')).toBe('657166')
  })
  it('rejects anything else', () => {
    for (const bad of ['', '12a', '-5', '1e5', ' 12', 12, null, undefined, {}, '9'.repeat(25)]) expect(parseId(bad)).toBeNull()
  })
})

describe('parseLayout', () => {
  const ok = {
    placements: [
      { id: '1', mode: 'live', rect: { x: 0, y: 40, width: 800, height: 600 } },
      { id: '2', mode: 'thumb', rect: { x: 810, y: 40, width: 200, height: 120 } },
      { id: '3', mode: 'parked' }
    ],
    attended: ['1']
  }

  it('accepts a well-formed layout', () => {
    expect(parseLayout(ok)).toEqual(ok)
  })

  it('rejects unknown modes, bad ids and non-finite or negative-size rects', () => {
    expect(parseLayout({ ...ok, placements: [{ id: '1', mode: 'float' }] })).toBeNull()
    expect(parseLayout({ ...ok, placements: [{ id: 'x', mode: 'parked' }] })).toBeNull()
    expect(parseLayout({ ...ok, placements: [{ id: '1', mode: 'live', rect: { x: NaN, y: 0, width: 1, height: 1 } }] })).toBeNull()
    expect(parseLayout({ ...ok, placements: [{ id: '1', mode: 'live', rect: { x: 0, y: 0, width: -1, height: 1 } }] })).toBeNull()
    expect(parseLayout({ ...ok, placements: [{ id: '1', mode: 'live' }] })).toBeNull()
  })

  it('rejects non-objects and missing arrays', () => {
    expect(parseLayout(null)).toBeNull()
    expect(parseLayout({ placements: 'x', attended: [] })).toBeNull()
    expect(parseLayout({ placements: [], attended: [5] })).toBeNull()
  })

  it('caps the number of placements', () => {
    const many = { placements: Array.from({ length: 1001 }, (_, i) => ({ id: String(i + 1), mode: 'parked' })), attended: [] }
    expect(parseLayout(many)).toBeNull()
  })

  it('drops unknown extra fields', () => {
    const extra = { placements: [{ id: '3', mode: 'parked', evil: true }], attended: [], more: 1 }
    expect(parseLayout(extra)).toEqual({ placements: [{ id: '3', mode: 'parked' }], attended: [] })
  })
})

describe('parseWorkspaces', () => {
  const good = [
    {
      id: 'w1',
      name: 'Dev',
      view: 'grid',
      slots: [{ rule: { processName: 'cmd.exe', titleIncludes: '' }, free: { x: 1, y: 2, width: 300, height: 200 } }]
    }
  ]

  it('accepts a valid list', () => {
    expect(parseWorkspaces(good)).toEqual(good)
  })

  it('loads a file written before names, colours and restore recipes existed, unchanged', () => {
    const old = [{ id: 'w0', name: 'Alt', view: 'focus', slots: [{ rule: { processName: 'WindowsTerminal.exe', titleIncludes: 'BMD' } }] }]
    expect(parseWorkspaces(old)).toEqual(old)
  })

  it('keeps name, colour, recipe and resume', () => {
    const full = [
      {
        id: 'w2',
        name: 'Projekt',
        view: 'focus',
        resume: true,
        slots: [
          { rule: { processName: 'cmd.exe', titleIncludes: '' }, label: 'Build', color: 'green', launch: { kind: 'window', host: 'conhost', shell: 'cmd', cwd: 'C:\\work' } },
          { rule: { processName: 'claude', titleIncludes: '' }, launch: { kind: 'agent', provider: 'claude', role: 'plain', cwd: 'C:\\work' } }
        ]
      }
    ]
    expect(parseWorkspaces(full)).toEqual(full)
  })

  it('drops a bad name, colour or recipe instead of losing the whole list', () => {
    const slot = { rule: { processName: 'cmd.exe', titleIncludes: '' }, label: 5, color: '#fff', launch: { kind: 'window', host: 'wt', cwd: 'C:\\x;calc' } }
    expect(parseWorkspaces([{ ...good[0], resume: 'yes', slots: [slot] }])).toEqual([{ ...good[0], slots: [{ rule: slot.rule }] }])
  })

  it('cleans a name read from disk like one typed in the page', () => {
    const slot = { rule: { processName: 'cmd.exe', titleIncludes: '' }, label: '--x; calc' }
    expect(parseWorkspaces([{ ...good[0], slots: [slot] }])?.[0].slots[0].label).toBe('x calc')
  })

  it('rejects bad views, missing names and overlong strings', () => {
    expect(parseWorkspaces([{ ...good[0], view: 'cube' }])).toBeNull()
    expect(parseWorkspaces([{ ...good[0], name: '' }])).toBeNull()
    expect(parseWorkspaces([{ ...good[0], name: 'x'.repeat(201) }])).toBeNull()
    expect(parseWorkspaces('nope')).toBeNull()
  })
})

describe('parseLang', () => {
  it('accepts exactly the two languages', () => {
    expect(parseLang('de')).toBe('de')
    expect(parseLang('en')).toBe('en')
  })
  it('rejects anything else', () => {
    for (const v of ['DE', 'fr', '', null, undefined, 1, ['en'], { lang: 'en' }]) expect(parseLang(v)).toBeNull()
  })
})

describe('agent tiles', () => {
  it('a layout may list agent tiles next to captured windows', () => {
    const layout = { placements: [{ id: 'a3', mode: 'parked' }, { id: '12', mode: 'parked' }], attended: ['a3'] }
    expect(parseLayout(layout)).toEqual(layout)
  })
  it('session ids are window handles or agent ids; window-only calls still take handles only', () => {
    expect(parseSessionId('a12')).toBe('a12')
    expect(parseSessionId('123')).toBe('123')
    expect(parseSessionId('a0')).toBeNull()
    expect(parseSessionId('b1')).toBeNull()
    expect(parseAgentId('a7')).toBe('a7')
    expect(parseAgentId('7')).toBeNull()
    expect(parseId('a7'), 'a capture must never get an agent id').toBeNull()
    expect(parseIdList(['a1', '5'])).toEqual(['a1', '5'])
  })
  it('a start request from the page: known program, orchestrator or plain, absolute folder, bounded task', () => {
    const ok = { provider: 'codex', role: 'orchestrator', cwd: 'C:\\work', task: 'do it' }
    expect(parseAgentStart(ok)).toEqual(ok)
    expect(parseAgentStart({ ...ok, role: 'plain', task: '' })).toEqual({ ...ok, role: 'plain', task: '' })
    expect(parseAgentStart({ ...ok, provider: 'bash' })).toBeNull()
    expect(parseAgentStart({ ...ok, role: 'worker' }), 'only an orchestrator starts workers').toBeNull()
    expect(parseAgentStart({ ...ok, cwd: 'relative\\dir' })).toBeNull()
    expect(parseAgentStart({ ...ok, task: 'x'.repeat(8001) })).toBeNull()
    expect(parseAgentStart({ ...ok, task: '  --dangerously-skip-permissions' }), 'a task is never read as a flag').toBeNull()
  })
  it('terminal sizes are sane integers', () => {
    expect(parseTerminalSize({ cols: 120, rows: 30 })).toEqual({ cols: 120, rows: 30 })
    expect(parseTerminalSize({ cols: 0, rows: 30 })).toBeNull()
    expect(parseTerminalSize({ cols: 12.5, rows: 30 })).toBeNull()
    expect(parseTerminalSize({ cols: 5000, rows: 30 })).toBeNull()
  })
})

describe('parseLayout: mirror of the big window', () => {
  it('keeps a mirror (and its clip) on a live placement', () => {
    const layout = { placements: [{ id: '5', mode: 'live', rect: { x: 1, y: 2, width: 3, height: 4 }, mirror: { x: 5, y: 6, width: 7, height: 8 }, clip: { x: 0, y: 0, width: 9, height: 9 } }], attended: [] }
    expect(parseLayout(layout)).toEqual(layout)
    expect(parseLayout({ placements: [{ id: '5', mode: 'live', rect: { x: 1, y: 2, width: 3, height: 4 }, mirror: { x: 'a' } }], attended: [] })).toBeNull()
  })
})
