import { describe, expect, it } from 'vitest'
import { resolveLang } from './lang'

describe('resolveLang', () => {
  it('a start override wins, then the saved choice', () => {
    expect(resolveLang({ override: 'en', saved: 'de', system: ['de-CH'] })).toBe('en')
    expect(resolveLang({ override: null, saved: 'en', system: ['de-CH'] })).toBe('en')
  })
  it('without a choice it follows the first Windows language: German stays German, everything else is English', () => {
    expect(resolveLang({ override: null, saved: null, system: ['de-CH', 'en-US'] })).toBe('de')
    expect(resolveLang({ override: null, saved: null, system: ['de'] })).toBe('de')
    expect(resolveLang({ override: null, saved: null, system: ['fr-CH', 'de-CH'] })).toBe('en')
    expect(resolveLang({ override: null, saved: null, system: [] })).toBe('en')
  })
})
