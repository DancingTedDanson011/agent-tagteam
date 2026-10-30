import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { absolutePath, date, digest, identity, invalidEvent, isRecord, KNOWN_CLAUDE_VERSIONS, listFiles, opaqueIdentity, rawExcerpt, readBounded, text } from './common'
import type { SourceAdapter, SourceEvent, SourceSession, SessionState } from './common'

export function parseSessionRecord(value: unknown, knownVersions: readonly string[] = KNOWN_CLAUDE_VERSIONS, now = new Date().toISOString()):
  { ok: true; session: SourceSession; raw: string } | { ok: false; event: SourceEvent } {
  let record = value
  if (typeof record === 'string') {
    try { record = JSON.parse(record) } catch { return { ok: false, event: invalidEvent('registry', 'Invalid registry JSON', record, now) } }
  }
  if (!isRecord(record)) return { ok: false, event: invalidEvent('registry', 'Registry record must be an object', record, now) }
  const sessionId = identity(record.sessionId)
  const cwd = absolutePath(record.cwd)
  const pid = typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0 ? record.pid : null
  if (!sessionId || !cwd || pid === null) return { ok: false, event: invalidEvent('registry', 'Registry identity is invalid', record, now) }
  if (record.procStart !== undefined && record.procStart !== null && !opaqueIdentity(record.procStart)) return { ok: false, event: invalidEvent('registry', 'Registry process identity is invalid', record, now) }
  const version = text(record.version, 100)
  const statusRaw = text(record.status, 200) || 'missing'
  const state: SessionState = ['busy', 'idle', 'shell', 'waiting'].includes(statusRaw) ? statusRaw as SessionState : 'unknown'
  return {
    ok: true,
    session: { sessionId, cwd, pid, name: text(record.name, 200) || sessionId, version, versionSupported: knownVersions.includes(version), state, statusRaw,
      startedAt: date(record.startedAt, now), updatedAt: date(record.updatedAt, now),
      ...(typeof record.procStart === 'string' || record.procStart === null ? { procStart: record.procStart } : {}),
      ...(typeof record.waitingFor === 'string' ? { currentTool: text(record.waitingFor) } : {}) },
    raw: rawExcerpt(record)
  }
}

export function readRegistry(dir: string, knownVersions: readonly string[] = KNOWN_CLAUDE_VERSIONS, now = new Date().toISOString()):
  { sessions: SourceSession[]; events: SourceEvent[]; adapter: SourceAdapter; complete: boolean } {
  const sessions: SourceSession[] = []; const events: SourceEvent[] = []
  const listing = listFiles(dir)
  if (listing.error) events.push(invalidEvent('registry', listing.error, '', now, dir))
  for (const name of listing.names.filter(name => /^\d+\.json$/.test(name))) {
    const file = join(dir, name); const loaded = readBounded(file)
    const result = 'error' in loaded ? { ok: false as const, event: invalidEvent('registry', loaded.error, '', now, file) } : parseSessionRecord(loaded.text, knownVersions, now)
    if (result.ok) {
      sessions.push(result.session)
      events.push({ id: `registry:snapshot:${digest(file + result.raw)}`, source: 'registry', kind: 'session_snapshot', at: result.session.updatedAt,
        sessionId: result.session.sessionId, cwd: result.session.cwd, summary: `${result.session.name}: ${result.session.statusRaw}`, raw: result.raw })
    }
    else events.push({ ...result.event, id: `registry:invalid:${digest(file + result.event.raw)}` })
  }
  const unknown = sessions.some(session => !session.versionSupported)
  const invalid = events.filter(event => event.kind === 'invalid').length
  return { sessions, events, complete: existsSync(dir) && !listing.error && invalid === 0,
    adapter: { source: 'registry', available: existsSync(dir), supported: !unknown, message: listing.error ?? (unknown ? 'Unverified Claude Code version' : 'Local session registry'), invalid } }
}
