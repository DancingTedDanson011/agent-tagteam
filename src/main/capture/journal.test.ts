import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Journal, type JournalEntry } from './journal'

function entry(hwnd: string): JournalEntry {
  return {
    hwnd,
    pid: 42,
    startTime: '133000000000000000',
    className: 'ConsoleWindowClass',
    style: 0x14ef0000,
    exStyle: 0xc0110,
    placement: {
      length: 44,
      flags: 0,
      showCmd: 1,
      ptMinPosition: { x: -1, y: -1 },
      ptMaxPosition: { x: -1, y: -1 },
      rcNormalPosition: { left: 10, top: 20, right: 810, bottom: 520 }
    }
  }
}

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'clio-journal-')), 'restore-journal.json')
}

describe('Journal', () => {
  it('persists an entry before returning from add()', () => {
    const file = tmpFile()
    const j = new Journal(file)
    j.add(entry('100'))
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.entries).toHaveLength(1)
    expect(onDisk.entries[0].hwnd).toBe('100')
  })

  it('survives a reload (crash recovery reads what the dead process wrote)', () => {
    const file = tmpFile()
    new Journal(file).add(entry('100'))
    new Journal(file).add(entry('200'))
    expect(new Journal(file).entries().map((e) => e.hwnd)).toEqual(['100', '200'])
  })

  it('replaces an entry for the same hwnd instead of duplicating it', () => {
    const file = tmpFile()
    const j = new Journal(file)
    j.add(entry('100'))
    j.add({ ...entry('100'), pid: 7 })
    expect(j.entries()).toHaveLength(1)
    expect(j.entries()[0].pid).toBe(7)
  })

  it('removes entries and writes the removal', () => {
    const file = tmpFile()
    const j = new Journal(file)
    j.add(entry('100'))
    j.add(entry('200'))
    j.remove('100')
    expect(new Journal(file).entries().map((e) => e.hwnd)).toEqual(['200'])
  })

  it('treats a missing file as empty', () => {
    expect(new Journal(tmpFile()).entries()).toEqual([])
  })

  it('treats a corrupt file as empty and does not throw', () => {
    const file = tmpFile()
    writeFileSync(file, '{"entries": [ broken')
    expect(new Journal(file).entries()).toEqual([])
  })

  it('reads a journal written with a UTF-8 BOM (Windows PowerShell 5.1 writes one)', () => {
    const file = tmpFile()
    writeFileSync(file, String.fromCharCode(0xfeff) + JSON.stringify({ version: 1, entries: [entry('300')] }))
    expect(new Journal(file).entries().map((e) => e.hwnd)).toEqual(['300'])
  })

  it('drops malformed entries instead of passing them on (the journal has a second writer)', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ pid: 1 }, { ...entry('abc') }, entry('400'), null] }))
    expect(new Journal(file).entries().map((e) => e.hwnd)).toEqual(['400'])
  })

  it('leaves no temp file behind', () => {
    const file = tmpFile()
    new Journal(file).add(entry('100'))
    expect(existsSync(file + '.tmp')).toBe(false)
  })
})
