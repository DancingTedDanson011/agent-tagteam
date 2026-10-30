import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite } from './fsutil'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'cg-cockpit-write-')); directories.push(dir); return dir }

describe('atomicWrite', () => {
  it('replaces persisted content and leaves no temporary file behind', () => {
    const dir = directory()
    const file = join(dir, 'settings.json')
    writeFileSync(file, 'previous')
    atomicWrite(file, 'next')
    expect(readFileSync(file, 'utf8')).toBe('next')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('reports a failed replacement and cleans only its own temporary file', () => {
    const dir = directory()
    const target = join(dir, 'existing-directory')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'preserved')
    expect(() => atomicWrite(target, 'cannot replace a directory')).toThrow()
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('preserved')
    expect(readdirSync(dir)).toEqual(['existing-directory'])
  })
})
