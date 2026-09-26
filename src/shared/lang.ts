// Which language the UI starts in. Only German and English exist.
import type { Lang } from './types'

/** A start override (--lang=, selftest) wins, then the saved choice, then the first Windows language. */
export function resolveLang(o: { override: Lang | null; saved: Lang | null; system: string[] }): Lang {
  if (o.override) return o.override
  if (o.saved) return o.saved
  return /^de(-|$)/i.test(o.system[0] ?? '') ? 'de' : 'en'
}
