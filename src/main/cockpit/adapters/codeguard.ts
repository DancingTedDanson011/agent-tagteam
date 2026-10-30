import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { absolutePath, date, digest, identity, invalidEvent, isRecord, rawExcerpt, text } from './common'
import type { SourceAdapter, SourceEvent } from './common'
import { ByteTail } from './transcript'

export function parseCodeguardRecord(value: unknown, now = new Date().toISOString()): SourceEvent {
  let data = value
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { return invalidEvent('codeguard', 'Invalid CODEGUARD JSON', data, now) } }
  if (!isRecord(data)) return invalidEvent('codeguard', 'CODEGUARD event must be an object', data, now)
  const raw = rawExcerpt(data); const mode = data.mode === 'hard' || data.mode === 'shadow' ? data.mode : 'unknown'
  const kind = text(data.event ?? data.gate ?? data.type, 100) || 'unknown'
  const cwd = absolutePath(data.cwd ?? data.project)
  const sessionId = identity(data.session_id ?? data.sessionId)
  return { id: `codeguard:${digest(raw)}`, source: 'codeguard', kind: `${mode}:${kind}`, at: date(data.timestamp ?? data.at ?? data.t, now),
    ...(cwd ? { cwd } : {}), ...(sessionId ? { sessionId } : {}), summary: text(`${mode}: ${kind} — ${text(data.reason ?? data.message)}`), raw }
}

export class CodeguardReader {
  private readonly tail = new ByteTail()
  constructor(private readonly guardDir: string) {}
  poll(now = new Date().toISOString()): { events: SourceEvent[]; adapter: SourceAdapter } {
    const file = join(this.guardDir, 'logs', 'events.jsonl'); const available = existsSync(file)
    if (!available) return { events: [], adapter: { source: 'codeguard', available: false, supported: false, message: 'CODEGUARD: not available', invalid: 0 } }
    const result = this.tail.read(file)
    const events = result.lines.filter(Boolean).map(line => parseCodeguardRecord(line, now))
    if (result.error) events.push(invalidEvent('codeguard', result.error, '', now))
    if (result.reset) events.push({ id: `codeguard:reset:${digest(file + now)}`, source: 'codeguard', kind: 'tail_reset', at: now, summary: 'Log rotated or truncated', raw: '' })
    if (result.oversized) events.push(invalidEvent('codeguard', 'Oversized log records skipped', '', now))
    return { events, adapter: { source: 'codeguard', available, supported: !result.error, message: result.error ?? 'Read-only appended CODEGUARD records', invalid: events.filter(event => event.kind === 'invalid').length } }
  }
}
