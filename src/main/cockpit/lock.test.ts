import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireWriterLock } from './lock'

const dirs: string[] = []
const handles: Array<{ close(): void }> = []
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clio-lock-'))
  dirs.push(dir)
  return join(dir, 'cockpit.lock')
}
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('cockpit writer coordination', () => {
  it('excludes another connection and releases the lock explicitly', () => {
    const path = file()
    const first = acquireWriterLock(path)
    expect(first).not.toBeNull()
    handles.push(first!)
    expect(acquireWriterLock(path)).toBeNull()
    first!.close()
    const next = acquireWriterLock(path)
    expect(next).not.toBeNull()
    handles.push(next!)
  })

  it('is released by the operating system when its owning process is killed', async () => {
    const path = file()
    const code = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE');process.stdout.write('held');setInterval(()=>{},1000)`
    const child = spawn(process.execPath, ['-e', code, path], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    try {
      await Promise.race([
        once(child.stdout!, 'data'),
        once(child, 'error').then(([error]) => Promise.reject(error)),
        once(child, 'exit').then(([exit]) => Promise.reject(new Error(`lock owner exited: ${exit}`)))
      ])
      expect(acquireWriterLock(path)).toBeNull()
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      const next = acquireWriterLock(path)
      expect(next).not.toBeNull()
      handles.push(next!)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
  })
})
