import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE, HOLD_MS, holdStep, parseVoiceSettings, type HoldState } from './voice'

describe('holdStep: tap types the key, holding records', () => {
  const idle: HoldState = { phase: 'idle' }
  it('a short tap is passed on as the character (minus stays typable)', () => {
    const [down] = holdStep(idle, { type: 'down', repeat: false }, 1000)
    expect(down).toEqual({ phase: 'pressed', since: 1000 })
    expect(holdStep(down, { type: 'up' }, 1200)).toEqual([idle, 'tap'])
  })
  it(`held for ${HOLD_MS} ms it starts recording; letting go stops`, () => {
    const [down] = holdStep(idle, { type: 'down', repeat: false }, 1000)
    expect(holdStep(down, { type: 'timer' }, 1000 + HOLD_MS - 1)).toEqual([down, null])
    const [rec, start] = holdStep(down, { type: 'timer' }, 1000 + HOLD_MS)
    expect(start).toBe('start')
    expect(rec).toEqual({ phase: 'recording' })
    expect(holdStep(rec, { type: 'up' }, 5000)).toEqual([idle, 'stop'])
  })
  it('key repeat while held changes nothing', () => {
    const [down] = holdStep(idle, { type: 'down', repeat: false }, 1000)
    expect(holdStep(down, { type: 'down', repeat: true }, 1100)).toEqual([down, null])
    const [rec] = holdStep(down, { type: 'timer' }, 1500)
    expect(holdStep(rec, { type: 'down', repeat: true }, 1600)).toEqual([rec, null])
  })
  it('a stray up or timer in idle does nothing', () => {
    expect(holdStep(idle, { type: 'up' }, 1)).toEqual([idle, null])
    expect(holdStep(idle, { type: 'timer' }, 1)).toEqual([idle, null])
  })
})

describe('parseVoiceSettings', () => {
  it('defaults: "-" held to talk, language detected, the turbo model', () => {
    expect(DEFAULT_VOICE).toEqual({ key: '-', lang: 'auto', model: 'large-v3-turbo' })
    expect(parseVoiceSettings(undefined)).toEqual(DEFAULT_VOICE)
  })
  it('keeps valid choices and replaces invalid ones with the default', () => {
    expect(parseVoiceSettings({ key: 'F9', lang: 'de', model: 'base' })).toEqual({ key: 'F9', lang: 'de', model: 'base' })
    expect(parseVoiceSettings({ key: 'x'.repeat(40), lang: 'fr', model: '../../evil' })).toEqual(DEFAULT_VOICE)
    expect(parseVoiceSettings({ key: 'Enter' }).key).toBe('-') // Enter must stay Enter
  })
})
