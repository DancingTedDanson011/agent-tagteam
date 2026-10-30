import { mkdirSync, mkdtempSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { decodeSourceChanges, startNativeSourceWatch, type SourceWatchEvent } from './source-watch'

function record(name: string, action = 1): Buffer {
  const text = Buffer.from(name, 'utf16le')
  const buffer = Buffer.alloc(12 + text.byteLength)
  buffer.writeUInt32LE(action, 4)
  buffer.writeUInt32LE(text.byteLength, 8)
  text.copy(buffer, 12)
  return buffer
}

it('rejects incomplete, overflowing and escaping native notifications instead of claiming a clean source', () => {
  expect(() => decodeSourceChanges(Buffer.alloc(64), 0, 'file')).toThrow(/overflow/i)
  expect(() => decodeSourceChanges(Buffer.alloc(8), 8, 'file')).toThrow(/notification/i)
  const truncated = record('source.ts'); truncated.writeUInt32LE(200, 8)
  expect(() => decodeSourceChanges(truncated, truncated.length, 'file')).toThrow(/notification/i)
  const invalidNext = record('source.ts'); invalidNext.writeUInt32LE(4)
  expect(() => decodeSourceChanges(invalidNext, invalidNext.length, 'file')).toThrow(/notification/i)
  for (const name of ['../outside', 'C:\\outside', 'source\0.ts']) {
    const buffer = record(name)
    expect(() => decodeSourceChanges(buffer, buffer.length, 'file')).toThrow(/notification/i)
  }
  const unknownAction = record('source.ts', 99)
  expect(() => decodeSourceChanges(unknownAction, unknownAction.length, 'file')).toThrow(/notification/i)
})

it('decodes an actual Windows notification layout without changing the recorded object kind', () => {
  const file = record('nested\\source.ts', 5)
  expect(decodeSourceChanges(file, file.length, 'file')).toEqual([{ path: 'nested/source.ts', kind: 'file', action: 'renamed_to' }])
  const directory = record('nested', 2)
  expect(decodeSourceChanges(directory, directory.length, 'directory')).toEqual([{ path: 'nested', kind: 'directory', action: 'removed' }])
})

it.skipIf(process.platform !== 'win32')('retains file kinds for rapid empty-file reuse and pure removed containers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clio-source-watch-'))
  const events: SourceWatchEvent[] = []
  const errors: Error[] = []
  const watcher = startNativeSourceWatch(root, event => events.push(event), error => errors.push(error))
  try {
    const reused = join(root, 'reused')
    mkdirSync(reused); rmdirSync(reused)
    writeFileSync(reused, ''); unlinkSync(reused)
    mkdirSync(join(root, 'container')); rmdirSync(join(root, 'container'))
    writeFileSync(join(root, 'old-name'), '')
    renameSync(join(root, 'old-name'), join(root, 'new-name'))
    const deadline = Date.now() + 5000
    while (!events.some(event => event.kind === 'file' && event.path === 'new-name') && !errors.length) {
      if (Date.now() > deadline) throw new Error('Native source notifications did not arrive')
      await delay(10)
    }
    await watcher.close()
    expect(errors).toEqual([])
    expect(events).toEqual(expect.arrayContaining([
      { path: 'reused', kind: 'directory', action: 'added' },
      { path: 'reused', kind: 'directory', action: 'removed' },
      { path: 'reused', kind: 'file', action: 'added' },
      { path: 'reused', kind: 'file', action: 'removed' },
      { path: 'container', kind: 'directory', action: 'added' },
      { path: 'container', kind: 'directory', action: 'removed' },
      { path: 'old-name', kind: 'file', action: 'renamed_from' },
      { path: 'new-name', kind: 'file', action: 'renamed_to' }
    ]))
    expect(events.filter(event => event.path === 'container').every(event => event.kind === 'directory')).toBe(true)
  } finally {
    await watcher.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 15000)

it.skipIf(process.platform !== 'win32')('cancels an idle native read and releases directory handles before cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clio-source-watch-idle-'))
  const errors: Error[] = []
  const watcher = startNativeSourceWatch(root, () => {}, error => errors.push(error))
  try {
    await watcher.close()
    await watcher.close()
    expect(errors).toEqual([])
    await rm(root, { recursive: true, force: true })
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 10000)

it.skipIf(process.platform !== 'win32')('observes existing projects beyond the legacy Windows path limit', async () => {
  const container = mkdtempSync(join(tmpdir(), 'clio-source-watch-long-'))
  const root = join(container, ...Array(6).fill('nested-project-directory-with-a-long-name'))
  const events: SourceWatchEvent[] = []
  const errors: Error[] = []
  const failures: unknown[] = []
  let watcher: ReturnType<typeof startNativeSourceWatch> | null = null
  try {
    mkdirSync(root, { recursive: true })
    expect(root.length).toBeGreaterThan(260)
    watcher = startNativeSourceWatch(root, event => events.push(event), error => errors.push(error))
    writeFileSync(join(root, 'source.ts'), 'actual source')
    await watcher.close()
    expect(errors).toEqual([])
    expect(events).toContainEqual({ path: 'source.ts', kind: 'file', action: 'added' })
  } catch (error) { failures.push(error) }
  finally {
    try { await watcher?.close() } catch (error) { failures.push(error) }
    try { await rm(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Long-path observation or cleanup failed')
  }
}, 15000)
