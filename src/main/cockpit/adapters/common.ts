import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { redact } from '../../agents/mcp'

export const MAX_SOURCE_BYTES = 256 * 1024
export const MAX_RAW_CHARS = 12_000
export const KNOWN_CLAUDE_VERSIONS = ['2.1.301', '2.1.302', '2.1.312'] as const
export type Source = 'registry' | 'hook' | 'transcript' | 'code_guardian' | 'codeguard'
export type SessionState = 'busy' | 'idle' | 'shell' | 'waiting' | 'error' | 'ended' | 'unknown'
export type SourceSession = {
  sessionId: string; cwd: string; pid: number | null; name: string; version: string; versionSupported: boolean
  state: SessionState; statusRaw: string; startedAt: string; updatedAt: string; currentTool?: string; endedAt?: string; procStart?: string | null
}
export type SourceWaiting = {
  sessionId: string; cwd: string; kind: 'question' | 'plan_approval' | 'permission' | 'dialog' | 'cg_decision' | 'cg_gate_ask' | 'other'
  ref: string; summary: string; openedAt: string; source: Source
}
export type SourceTask = {
  source: 'claude_task' | 'code_guardian'; sourceRef: string; cwd: string; sessionId: string | null
  title: string; state: 'open' | 'in_progress' | 'done' | 'dropped'; sourceState?: string; contractId?: string; metadata?: Record<string, string>
}
export type SourceEvent = { id: string; source: Source; kind: string; at: string; cwd?: string; sessionId?: string; summary: string; raw: string }
export type SourceAdapter = { source: Source; available: boolean; supported: boolean; message: string; version?: string; invalid: number }
export type LifecycleSnapshot = { sessions: SourceSession[]; waiting: SourceWaiting[]; tasks: SourceTask[] }
export type FileIdentity = { device: string; inode: string; birthtimeNs: string }
export const fileIdentity = (stat: BigIntStats): FileIdentity => ({ device: String(stat.dev), inode: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) })
export const sameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean => left.device === right.device && left.inode === right.inode && left.birthtimeNs === right.birthtimeNs

const decodedKey = (key: string): string => key.replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
const sensitiveKey = (key: string): boolean => /password|passwd|secret|token|api[_-]?key|authorization|cookie|socket/i.test(decodedKey(key))
/** Malformed or embedded JSON is not safe to parse; inspect decoded keys and hide the remaining value text. */
function maskEmbeddedCredentials(value: string): string {
  for (const match of value.matchAll(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*:/g)) {
    if (sensitiveKey(match[1].slice(1, -1))) return value.slice(0, (match.index ?? 0) + match[0].length) + '"****"'
  }
  return value
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export const text = (value: unknown, max = 2000): string => typeof value === 'string' ? maskEmbeddedCredentials(redact(value))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max) : ''
export const identity = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) && text(value, 200) === value ? value : ''
export const opaqueIdentity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/\s/.test(value) && text(value, 200) === value
export const absolutePath = (value: unknown): string => typeof value === 'string' && value.length <= 4096 && !/[\u0000\r\n]/.test(value) && text(value, 4096) === value && (isAbsolute(value) || win32.isAbsolute(value)) ? value : ''
export function date(value: unknown, fallback: string): string {
  // Real registry fixtures carry Unix epoch milliseconds. procStart is deliberately never passed here.
  const milliseconds = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' && Number.isSafeInteger(value) ? value : NaN
  const parsed = new Date(milliseconds)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24)

/** Unknown fields remain inspectable, within a fixed depth/size and with secret field values removed. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth limit]'
  if (typeof value === 'string') return text(value, 3000)
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (Array.isArray(value)) return value.slice(0, 64).map(item => sanitize(item, depth + 1))
  if (!isRecord(value)) return '[unsupported]'
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [
    text(key, 100), sensitiveKey(key) ? '****' : sanitize(item, depth + 1)
  ]))
}
export const rawExcerpt = (value: unknown): string => (typeof value === 'string' ? text(value, MAX_RAW_CHARS) : JSON.stringify(sanitize(value))).slice(0, MAX_RAW_CHARS)

export function invalidEvent(source: Source, reason: string, raw: unknown, at = new Date().toISOString(), ref = ''): SourceEvent {
  const safe = rawExcerpt(raw)
  return { id: `${source}:invalid:${digest(ref + reason + safe)}`, source, kind: 'invalid', at, summary: text(reason), raw: safe }
}

/** Read at most the source limit even if a file grows after stat. Symlink files are not source records. */
export function readBounded(file: string): { text: string; fileIdentity: FileIdentity } | { error: string } {
  let fd: number | undefined
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return { error: 'Not a regular source file' }
    if (stat.size > MAX_SOURCE_BYTES) return { error: 'Source exceeds byte limit' }
    fd = openSync(file, 'r')
    const descriptor = fstatSync(fd, { bigint: true })
    if (!descriptor.isFile() || descriptor.size > BigInt(MAX_SOURCE_BYTES)) return { error: 'Descriptor is not a bounded regular source file' }
    const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null)
      if (read === 0) break
      length += read
    }
    return length > MAX_SOURCE_BYTES ? { error: 'Source exceeds byte limit' } : { text: bytes.subarray(0, length).toString('utf8'), fileIdentity: fileIdentity(descriptor) }
  } catch (error) { return { error: text(error instanceof Error ? error.message : 'Source read failed') } }
  finally { if (fd !== undefined) closeSync(fd) }
}

export function listFiles(dir: string, cap = 512): { names: string[]; error?: string } {
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort()
    return { names: entries.slice(0, cap), ...(entries.length > cap ? { error: 'Source directory exceeds entry limit' } : {}) }
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { names: [] }
    return { names: [], error: text(error instanceof Error ? error.message : 'Source listing failed') }
  }
}
