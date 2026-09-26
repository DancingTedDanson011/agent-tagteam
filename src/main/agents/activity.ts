// Badges for agent tiles, with the same state machine as captured windows (../activity/activity.ts):
// the terminal title is the exact signal (Claude Code), otherwise a changing screen counts as work.
import type { Activity } from '../../shared/types'
import { DEFAULT_ACTIVITY_CONFIG, initialActivity, parseTitleHint, step, type ActivityState } from '../activity/activity'

export type Observed = { now: number; screen: string; title: string }

/** A changed screen hash stands for "many changed blocks"; an unchanged one for none. */
const CHANGED = DEFAULT_ACTIVITY_CONFIG.changeThreshold + 1

export class AgentActivity {
  private readonly states = new Map<string, ActivityState>()
  private readonly screens = new Map<string, string>()
  private readonly badges = new Set<string>()

  tick(id: string, o: Observed, attended: boolean): void {
    const prev = this.screens.get(id)
    this.screens.set(id, o.screen)
    const changedBlocks = prev === undefined ? null : prev === o.screen ? 0 : CHANGED
    const r = step(this.states.get(id) ?? initialActivity(), { now: o.now, changedBlocks, titleHint: parseTitleHint(o.title) }, DEFAULT_ACTIVITY_CONFIG)
    this.states.set(id, r.state)
    if (attended) this.badges.delete(id)
    else if (r.becameWaiting) this.badges.add(id)
  }

  info(id: string): { activity: Activity; badge: boolean } {
    return { activity: this.states.get(id)?.activity ?? 'idle', badge: this.badges.has(id) }
  }

  clearBadge(id: string): void {
    this.badges.delete(id)
  }

  forget(id: string): void {
    this.states.delete(id)
    this.screens.delete(id)
    this.badges.delete(id)
  }
}
