import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { VoiceWorker, type VoiceProcess } from './worker'

/** A stand-in for the Python process: records requests, answers when told to. */
function fakeProcess() {
  const out = new EventEmitter()
  const proc = new EventEmitter() as EventEmitter & VoiceProcess & { requests: Array<Record<string, unknown>>; say(o: object): void; die(): void }
  proc.requests = []
  proc.stdout = out as unknown as VoiceProcess['stdout']
  const stdin = new EventEmitter() as EventEmitter & { write(line: string): boolean }
  stdin.write = (line: string) => (proc.requests.push(JSON.parse(line)), true)
  proc.stdin = stdin as unknown as VoiceProcess['stdin']
  proc.kill = () => true
  proc.say = (o) => out.emit('data', Buffer.from(JSON.stringify(o) + '\n'))
  proc.die = () => proc.emit('exit', 1)
  return proc
}

describe('VoiceWorker', () => {
  it('starts the process once, waits until the model is ready, then answers by id', async () => {
    const procs: Array<ReturnType<typeof fakeProcess>> = []
    const w = new VoiceWorker(() => (procs.push(fakeProcess()), procs[procs.length - 1]), { timeoutMs: 1000 })
    const p1 = w.transcribe('C:\\a.webm', 'de')
    const p2 = w.transcribe('C:\\b.webm', null)
    expect(procs).toHaveLength(1)
    procs[0].say({ ready: true, device: 'cuda' })
    await new Promise((r) => setTimeout(r, 0))
    expect(procs[0].requests.map((r) => [r.path, r.lang])).toEqual([['C:\\a.webm', 'de'], ['C:\\b.webm', null]])
    procs[0].say({ id: procs[0].requests[1].id, text: 'zweites' })
    procs[0].say({ id: procs[0].requests[0].id, text: 'erstes' })
    await expect(p1).resolves.toBe('erstes')
    await expect(p2).resolves.toBe('zweites')
  })

  it('reports a missing faster-whisper instead of hanging', async () => {
    const w = new VoiceWorker(() => {
      const p = fakeProcess()
      setTimeout(() => p.say({ fatal: 'faster-whisper not available' }), 0)
      return p
    }, { timeoutMs: 1000 })
    await expect(w.transcribe('C:\\a.webm', null)).rejects.toThrow(/faster-whisper not available/)
  })

  it('a crashed process fails what was waiting, and the next request starts a new one', async () => {
    const procs: Array<ReturnType<typeof fakeProcess>> = []
    const w = new VoiceWorker(() => (procs.push(fakeProcess()), procs[procs.length - 1]), { timeoutMs: 1000 })
    const p = w.transcribe('C:\\a.webm', null)
    procs[0].say({ ready: true })
    await new Promise((r) => setTimeout(r, 0))
    procs[0].die()
    await expect(p).rejects.toThrow(/stopped/)
    const again = w.transcribe('C:\\b.webm', null)
    expect(procs).toHaveLength(2)
    procs[1].say({ ready: true })
    await new Promise((r) => setTimeout(r, 0))
    procs[1].say({ id: procs[1].requests[0].id, text: 'ok' })
    await expect(again).resolves.toBe('ok')
  })

  it('stop() fails what is waiting at once (model change mid-recognition), and the next request restarts (cold review)', async () => {
    const procs: Array<ReturnType<typeof fakeProcess>> = []
    const w = new VoiceWorker(() => (procs.push(fakeProcess()), procs[procs.length - 1]), { timeoutMs: 60_000 })
    const p = w.transcribe('C:\\a.webm', null)
    procs[0].say({ ready: true })
    await new Promise((r) => setTimeout(r, 0))
    w.stop()
    await expect(p).rejects.toThrow(/stopped/)
    void w.transcribe('C:\\b.webm', null).catch(() => undefined)
    expect(procs).toHaveLength(2)
  })

  it('a timed-out request replaces the stuck process instead of queueing behind it (cold review)', async () => {
    const procs: Array<ReturnType<typeof fakeProcess>> = []
    const w = new VoiceWorker(() => (procs.push(fakeProcess()), procs[procs.length - 1]), { timeoutMs: 30 })
    const p = w.transcribe('C:\\a.webm', null)
    procs[0].say({ ready: true })
    await expect(p).rejects.toThrow(/timed out/)
    void w.transcribe('C:\\b.webm', null).catch(() => undefined)
    expect(procs).toHaveLength(2)
  })

  it('a broken stdin (EPIPE) fails the requests instead of crashing the app (cold review)', async () => {
    const procs: Array<ReturnType<typeof fakeProcess>> = []
    const w = new VoiceWorker(() => (procs.push(fakeProcess()), procs[procs.length - 1]), { timeoutMs: 60_000 })
    const p = w.transcribe('C:\\a.webm', null)
    procs[0].say({ ready: true })
    await new Promise((r) => setTimeout(r, 0))
    ;(procs[0].stdin as unknown as EventEmitter).emit('error', new Error('write EPIPE'))
    await expect(p).rejects.toThrow(/EPIPE/)
  })

  it('loading the model has its own, longer limit (a first download takes minutes)', async () => {
    const procs: Array<ReturnType<typeof fakeProcess>> = []
    const w = new VoiceWorker(() => (procs.push(fakeProcess()), procs[procs.length - 1]), { timeoutMs: 20, loadTimeoutMs: 200 })
    const p = w.transcribe('C:\\a.webm', null)
    await new Promise((r) => setTimeout(r, 60)) // longer than a request may take, shorter than loading
    procs[0].say({ ready: true })
    await new Promise((r) => setTimeout(r, 0))
    procs[0].say({ id: procs[0].requests[0].id, text: 'geladen' })
    await expect(p).resolves.toBe('geladen')
  })

  it('a process that cannot start (spawn error) fails at once, not after the timeout', async () => {
    const w = new VoiceWorker(() => {
      const p = fakeProcess()
      setTimeout(() => p.emit('error', new Error('spawn ENOENT')), 0)
      return p
    }, { timeoutMs: 60_000 })
    await expect(w.transcribe('C:\\a.webm', null)).rejects.toThrow(/ENOENT/)
  })

  it('an error for one request fails only that one; a silent process times out', async () => {
    const procs: Array<ReturnType<typeof fakeProcess>> = []
    const w = new VoiceWorker(() => (procs.push(fakeProcess()), procs[procs.length - 1]), { timeoutMs: 30 })
    const p = w.transcribe('C:\\a.webm', null)
    procs[0].say({ ready: true })
    await new Promise((r) => setTimeout(r, 0))
    procs[0].say({ id: procs[0].requests[0].id, error: 'bad audio' })
    await expect(p).rejects.toThrow(/bad audio/)
    await expect(w.transcribe('C:\\b.webm', null)).rejects.toThrow(/timed out/)
  })
})
