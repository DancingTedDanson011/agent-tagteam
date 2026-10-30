import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ByteTail, parseTranscriptRecord } from './transcript'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('tails only appended bytes, retains partial UTF8/lines, and restarts after truncation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-tail-')); dirs.push(dir)
  const file = join(dir, 'transcript.jsonl')
  writeFileSync(file, 'historic\n')
  const tail = new ByteTail()
  expect(tail.read(file).lines).toEqual([])
  const line = Buffer.from('Grüezi\n')
  appendFileSync(file, line.subarray(0, 3))
  expect(tail.read(file).lines).toEqual([])
  appendFileSync(file, line.subarray(3))
  expect(tail.read(file).lines).toEqual(['Grüezi'])
  writeFileSync(file, 'new\n')
  expect(tail.read(file)).toMatchObject({ lines: ['new'], reset: true })
})
it('drops an oversized line without joining its suffix into a false event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-tail-')); dirs.push(dir)
  const file = join(dir, 'events.jsonl'); writeFileSync(file, '')
  const tail = new ByteTail({ startAtEnd: false, maxLineBytes: 8, maxReadBytes: 64 })
  appendFileSync(file, 'abcdefghijkl')
  expect(tail.read(file).lines).toEqual([])
  appendFileSync(file, 'mnop\nvalid\n')
  expect(tail.read(file).lines).toEqual(['valid'])
})
it('detects truncation followed by same-size replacement between polls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-tail-')); dirs.push(dir)
  const file = join(dir, 'same-size.jsonl'); writeFileSync(file, 'before\n')
  const tail = new ByteTail({ startAtEnd: false })
  expect(tail.read(file).lines).toEqual(['before'])
  writeFileSync(file, 'after!\n')
  expect(tail.read(file)).toMatchObject({ lines: ['after!'], reset: true })
})
it('extracts tool metadata using cwd from the record and never exposes reasoning or prose', () => {
  const record = { type: 'assistant', cwd: '/real/project', sessionId: 'sid', version: '2.1.301', message: { content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'private prose' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { secret: 'private input' } }] } }
  const result = parseTranscriptRecord(record)
  expect(result?.cwd).toBe('/real/project')
  expect(result?.summary).toContain('Read')
  expect(JSON.stringify(result)).not.toContain('private')
  expect(parseTranscriptRecord({ ...record, type: 'future' })).toBeNull()
})
