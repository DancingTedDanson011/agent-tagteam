import { closeSync, lstatSync, openSync, readSync } from 'node:fs'
import { absolutePath, date, digest, identity, isRecord, rawExcerpt, text } from './common'
import type { SourceEvent } from './common'

type Cursor = { offset: number; device: number; inode: number; pending: Buffer; dropping: boolean; skippingAttachedLine: boolean; anchor: Buffer }
export type TailResult = { lines: string[]; offset: number; reset: boolean; oversized: number; error?: string }
/** A cursor advances in bytes; decoding happens only after a complete newline-delimited record. */
export class ByteTail {
  private readonly cursors = new Map<string, Cursor>()
  constructor(private readonly options: { startAtEnd?: boolean; maxReadBytes?: number; maxLineBytes?: number } = {}) {}
  read(file: string): TailResult {
    const maxRead = this.options.maxReadBytes ?? 256 * 1024
    const maxLine = this.options.maxLineBytes ?? 256 * 1024
    let fd: number | undefined
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) return { lines: [], offset: 0, reset: false, oversized: 0, error: 'Not a regular tail source' }
      fd = openSync(file, 'r')
      let cursor = this.cursors.get(file)
      let rewritten = false
      if (cursor && cursor.anchor.length > 0 && stat.size >= cursor.offset) {
        const probe = Buffer.alloc(cursor.anchor.length)
        const read = readSync(fd, probe, 0, probe.length, cursor.offset - probe.length)
        rewritten = read !== probe.length || !probe.equals(cursor.anchor)
      }
      const reset = !!cursor && (stat.size < cursor.offset || stat.ino !== cursor.inode || stat.dev !== cursor.device || rewritten)
      if (!cursor || reset) {
        const offset = !cursor && this.options.startAtEnd !== false ? stat.size : 0
        const last = Buffer.alloc(1)
        const partial = !cursor && offset > 0 && readSync(fd, last, 0, 1, offset - 1) === 1 && last[0] !== 10
        cursor = { offset, device: stat.dev, inode: stat.ino, pending: Buffer.alloc(0), dropping: partial, skippingAttachedLine: partial, anchor: Buffer.alloc(0) }
        this.cursors.set(file, cursor)
      }
      const size = Math.min(maxRead, Math.max(0, stat.size - cursor.offset))
      const bytes = Buffer.alloc(size)
      const read = size > 0 ? readSync(fd, bytes, 0, size, cursor.offset) : 0
      cursor.offset += read
      const anchor = Buffer.alloc(Math.min(64, cursor.offset))
      const anchorRead = anchor.length ? readSync(fd, anchor, 0, anchor.length, cursor.offset - anchor.length) : 0
      cursor.anchor = anchor.subarray(0, anchorRead)
      const joined = Buffer.concat([cursor.pending, bytes.subarray(0, read)])
      const lines: string[] = []; let start = 0; let oversized = 0
      for (let index = 0; index < joined.length; index++) {
        if (joined[index] !== 10) continue
        const line = joined.subarray(start, index)
        if (!cursor.dropping && line.length <= maxLine) lines.push(line.toString('utf8').replace(/\r$/, ''))
        else if (!cursor.skippingAttachedLine) oversized++
        cursor.dropping = false; cursor.skippingAttachedLine = false; start = index + 1
      }
      const rest = joined.subarray(start)
      if (cursor.dropping || rest.length > maxLine) { cursor.pending = Buffer.alloc(0); cursor.dropping = true }
      else cursor.pending = Buffer.from(rest)
      return { lines, offset: cursor.offset, reset, oversized }
    } catch (error) { return { lines: [], offset: this.cursors.get(file)?.offset ?? 0, reset: false, oversized: 0, error: text(error instanceof Error ? error.message : 'Tail read failed') } }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  forget(file: string): void { this.cursors.delete(file) }
}

/** Only tool metadata is exposed. Transcript prose, thinking and tool input/output are excluded. */
export function parseTranscriptRecord(value: unknown, now = new Date().toISOString()): SourceEvent | null {
  let data = value
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { return null } }
  if (!isRecord(data) || !['user', 'assistant'].includes(text(data.type)) || !absolutePath(data.cwd) || !identity(data.sessionId)) return null
  const message = isRecord(data.message) ? data.message : {}
  if (!Array.isArray(message.content)) return null
  const tools = message.content.filter(isRecord).filter(item => item.type === 'tool_use' || item.type === 'tool_result').slice(0, 64).map(item =>
    item.type === 'tool_use' ? { type: 'tool_use', id: identity(item.id), name: text(item.name, 100) } : { type: 'tool_result', tool_use_id: identity(item.tool_use_id), is_error: item.is_error === true })
  if (tools.length === 0) return null
  const safe = { type: data.type, version: text(data.version, 100), cwd: data.cwd, sessionId: data.sessionId, tools }
  const raw = rawExcerpt(safe)
  return { id: `transcript:${digest(raw + text(data.uuid))}`, source: 'transcript', kind: 'tool_metadata', at: date(data.timestamp, now), cwd: data.cwd as string,
    sessionId: data.sessionId as string, summary: tools.map(tool => 'name' in tool ? tool.name : 'tool result').join(', '), raw }
}
