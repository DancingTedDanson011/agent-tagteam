import { describe, expect, it } from 'vitest'
import { COLORS, parseColorId, parseLabel, parseSlotLaunch } from './restore'

describe('parseLabel', () => {
  it('keeps a plain name', () => {
    expect(parseLabel('Backend API')).toBe('Backend API')
    expect(parseLabel('  Bäckerei ✓  ')).toBe('Bäckerei ✓')
  })
  it('removes what a command line could read as syntax: ; " \\ control characters and leading dashes', () => {
    // Windows Terminal splits its arguments at ";" (measured: a title "CLIO-SPIKE; X" became two tabs)
    expect(parseLabel('Front; wt new-tab calc')).toBe('Front wt new-tab calc')
    expect(parseLabel('a"b\\c')).toBe('abc')
    expect(parseLabel('x\u001b[31my\u0007')).toBe('x[31my')
    expect(parseLabel('--help')).toBe('help')
    expect(parseLabel(' - -x')).toBe('x')
  })
  it('caps at 60 characters and refuses non-text', () => {
    expect(parseLabel('x'.repeat(80))).toBe('x'.repeat(60))
    expect(parseLabel(42)).toBeNull()
    expect(parseLabel(undefined)).toBeNull()
    expect(parseLabel(';;;')).toBe('')
  })
})

describe('parseColorId', () => {
  it('accepts only palette ids, never free CSS', () => {
    expect(parseColorId('blue')).toBe('blue')
    expect(parseColorId('#ff0000')).toBeNull()
    expect(parseColorId('red; background:url(x)')).toBeNull()
    expect(parseColorId(undefined)).toBeNull()
  })
  it('has eight colours, each a #rrggbb value', () => {
    expect(Object.keys(COLORS)).toHaveLength(8)
    for (const hex of Object.values(COLORS)) expect(hex).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('parseSlotLaunch', () => {
  it('accepts the three shapes', () => {
    expect(parseSlotLaunch({ kind: 'agent', provider: 'claude', role: 'plain', cwd: 'C:\\work' })).toEqual({ kind: 'agent', provider: 'claude', role: 'plain', cwd: 'C:\\work' })
    expect(parseSlotLaunch({ kind: 'window', host: 'conhost', shell: 'cmd', cwd: 'C:\\work', run: 'claude' })).toEqual({ kind: 'window', host: 'conhost', shell: 'cmd', cwd: 'C:\\work', run: 'claude' })
    expect(parseSlotLaunch({ kind: 'window', host: 'wt', cwd: null })).toEqual({ kind: 'window', host: 'wt', cwd: null })
  })
  it('drops unknown fields', () => {
    expect(parseSlotLaunch({ kind: 'window', host: 'wt', cwd: null, args: ['/c', 'calc'] })).toEqual({ kind: 'window', host: 'wt', cwd: null })
  })
  it.each([
    ['worker role', { kind: 'agent', provider: 'claude', role: 'worker', cwd: 'C:\\w' }],
    ['unknown provider', { kind: 'agent', provider: 'bash', role: 'plain', cwd: 'C:\\w' }],
    ['relative folder', { kind: 'agent', provider: 'cmd', role: 'plain', cwd: 'work' }],
    ['unknown shell', { kind: 'window', host: 'conhost', shell: 'bash', cwd: null }],
    ['unknown run', { kind: 'window', host: 'wt', cwd: null, run: 'calc' }],
    ['unknown host', { kind: 'window', host: 'mintty', cwd: null }],
    ['a ; in a Windows Terminal folder (it would split the command)', { kind: 'window', host: 'wt', cwd: 'C:\\x;calc' }],
    ['a device path', { kind: 'window', host: 'conhost', shell: 'cmd', cwd: '\\\\?\\C:\\x' }],
    ['a .. segment', { kind: 'window', host: 'conhost', shell: 'cmd', cwd: 'C:\\a\\..\\b' }],
    ['an overlong folder', { kind: 'window', host: 'conhost', shell: 'cmd', cwd: 'C:\\' + 'x'.repeat(1100) }]
  ])('refuses %s', (_name, v) => {
    expect(parseSlotLaunch(v)).toBeNull()
  })
})
