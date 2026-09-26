import { describe, expect, it } from 'vitest'
import { de, en } from './i18n'

type Tree = { [k: string]: unknown }
const leaves = (t: Tree, prefix = ''): Array<[string, unknown]> =>
  Object.entries(t).flatMap(([k, v]) => (v && typeof v === 'object' ? leaves(v as Tree, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]))
const text = (v: unknown): string => (typeof v === 'function' ? String((v as (...a: unknown[]) => unknown)('X', 2)) : String(v))

describe('dictionaries', () => {
  it('English has exactly the German keys', () => {
    expect(leaves(en as unknown as Tree).map(([k]) => k).sort()).toEqual(leaves(de as unknown as Tree).map(([k]) => k).sort())
  })
  it('no text is empty and every placeholder is used', () => {
    for (const dict of [de, en]) {
      for (const [key, v] of leaves(dict as unknown as Tree)) {
        expect(text(v).trim(), key).not.toBe('')
        if (typeof v === 'function') expect(text(v), key).toContain('X')
      }
    }
  })
})
