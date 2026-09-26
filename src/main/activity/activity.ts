// Decides when a session "waits for you": after a phase of work has ended.
// Two signals feed it: the window title (Claude Code prefixes it with a spinner glyph while
// working and with ✳ when idle — observed live 2026-09-22) and pixel changes of the window.
// The title signal is exact and wins whenever it is present.
import type { Activity } from '../../shared/types'

export type TitleHint = 'working' | 'idle' | null

export type ActivityConfig = {
  /** Changed 8x16 blocks per tick at or below this count are noise (blinking cursor). */
  changeThreshold: number
  /** A work phase ends after this long without changes. */
  quietMs: number
  /** Work phases shorter than this end silently (single redraws, one-off log lines). */
  minWorkMs: number
}

export const DEFAULT_ACTIVITY_CONFIG: ActivityConfig = { changeThreshold: 2, quietMs: 4000, minWorkMs: 1500 }

export type ActivityState = { activity: Activity; workStartedAt: number; lastChangeAt: number }

export type Tick = { now: number; changedBlocks: number | null; titleHint: TitleHint }

const WORKING_GLYPHS = new Set(['◐', '◓', '◑', '◒'])
const IDLE_GLYPHS = new Set(['✳'])

export function parseTitleHint(title: string): TitleHint {
  const first = Array.from(title.trimStart())[0]
  if (!first) return null
  if (IDLE_GLYPHS.has(first)) return 'idle'
  const code = first.codePointAt(0) ?? 0
  if (WORKING_GLYPHS.has(first) || (code >= 0x2801 && code <= 0x28ff)) return 'working'
  return null
}

export function initialActivity(): ActivityState {
  return { activity: 'idle', workStartedAt: 0, lastChangeAt: 0 }
}

export function step(
  state: ActivityState,
  tick: Tick,
  cfg: ActivityConfig
): { state: ActivityState; becameWaiting: boolean } {
  if (tick.titleHint === 'working') {
    const started = state.activity === 'working' ? state.workStartedAt : tick.now
    return { state: { activity: 'working', workStartedAt: started, lastChangeAt: tick.now }, becameWaiting: false }
  }
  if (tick.titleHint === 'idle') {
    if (state.activity === 'working') return { state: { ...state, activity: 'waiting' }, becameWaiting: true }
    return { state, becameWaiting: false }
  }

  const changed = tick.changedBlocks !== null && tick.changedBlocks > cfg.changeThreshold
  if (changed) {
    const started = state.activity === 'working' ? state.workStartedAt : tick.now
    return { state: { activity: 'working', workStartedAt: started, lastChangeAt: tick.now }, becameWaiting: false }
  }
  if (state.activity === 'working' && tick.now - state.lastChangeAt >= cfg.quietMs) {
    const worked = state.lastChangeAt - state.workStartedAt >= cfg.minWorkMs
    return { state: { ...state, activity: worked ? 'waiting' : 'idle' }, becameWaiting: worked }
  }
  return { state, becameWaiting: false }
}
