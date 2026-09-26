// The local speech-to-text worker (resources/clio-whisper.py): started on first use, kept running so
// the model loads once, one JSON line per request and answer. Measured 2026-09-25 on this machine:
// faster-whisper large-v3-turbo on CUDA, 12.6 s for the first request including the model load.
import type { Readable, Writable } from 'node:stream'

export type VoiceProcess = {
  stdout: Readable
  stdin: Writable
  kill(): boolean
  on(event: 'exit', cb: (code: number | null) => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
}

type Pending = { resolve(text: string): void; reject(err: Error): void; timer: NodeJS.Timeout }

/** Loading may include a first model download (minutes); one recognition may not. */
const DEFAULT_LOAD_TIMEOUT_MS = 15 * 60_000

export class VoiceWorker {
  private proc: VoiceProcess | null = null
  private ready: Promise<void> | null = null
  private readonly pending = new Map<string, Pending>()
  private next = 1

  constructor(
    private readonly spawn: () => VoiceProcess,
    private readonly opts: { timeoutMs: number; loadTimeoutMs?: number }
  ) {}

  /** Text for the audio file (lang null: detected). Rejects with a reason the page can show. */
  async transcribe(path: string, lang: string | null): Promise<string> {
    await this.start()
    const proc = this.proc
    if (!proc) throw new Error('speech recognition stopped') // died between ready and now
    const id = String(this.next++)
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // a stuck process is replaced, not queued behind (cold review)
        this.stopWith(proc, new Error('speech recognition timed out'))
      }, this.opts.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      proc.stdin.write(JSON.stringify({ id, path, lang }) + '\n')
    })
  }

  /** Ends the process; whatever is waiting fails now (e.g. the model was changed mid-recognition). */
  stop(): void {
    if (this.proc) this.stopWith(this.proc, new Error('speech recognition stopped'))
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready
    const proc = this.spawn()
    this.proc = proc
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('speech recognition timed out while loading')), this.opts.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS)
      const fail = (err: Error) => {
        clearTimeout(timer)
        this.stopWith(proc, err)
        reject(err)
      }
      let buf = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          let msg: { ready?: boolean; fatal?: string; id?: string; text?: string; error?: string }
          try {
            msg = JSON.parse(line)
          } catch {
            continue // stdout carries only JSON; anything else is ignored
          }
          if (msg.fatal) fail(new Error(msg.fatal))
          else if (msg.ready) {
            clearTimeout(timer)
            resolve()
          } else if (msg.id !== undefined) this.answer(String(msg.id), msg)
        }
      })
      proc.on('exit', () => fail(new Error('speech recognition stopped')))
      proc.on('error', (err) => fail(err)) // could not start at all (e.g. python.exe vanished)
      // a dead process's pipe: EPIPE on write would otherwise be an uncaught error in main (cold review)
      proc.stdin.on('error', (err: Error) => fail(err))
    })
    return this.ready
  }

  private answer(id: string, msg: { text?: string; error?: string }): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (typeof msg.text === 'string') p.resolve(msg.text)
    else p.reject(new Error(msg.error ?? 'speech recognition failed'))
  }

  /** Everything still waiting fails; the next request starts a fresh process. */
  private stopWith(proc: VoiceProcess, err: Error): void {
    if (this.proc !== proc) return
    this.proc = null
    this.ready = null
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }
}
