// Serializes changes to each foreign window: at most one call per window is in flight, so a hung
// window can occupy at most one worker thread. Positioning requests coalesce (only the latest runs).

export class WindowOps {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly latest = new Map<string, () => Promise<unknown>>()
  private readonly coalescing = new Set<string>()

  /** Runs `job` after every earlier job for this window has finished. */
  run<T>(id: string, job: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve()
    const result = prev.then(job, job)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.chains.set(id, tail)
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id)
    })
    return result
  }

  /** Like run(), but while a job is queued only the most recent request is kept. */
  coalesce(id: string, job: () => Promise<unknown>): void {
    this.latest.set(id, job)
    if (this.coalescing.has(id)) return
    this.coalescing.add(id)
    void this.run(id, async () => {
      this.coalescing.delete(id)
      const next = this.latest.get(id)
      this.latest.delete(id)
      if (next) await next()
    })
  }

  /** Resolves when every queued job for this window has finished. */
  idle(id: string): Promise<void> {
    return this.chains.get(id) ?? Promise.resolve()
  }

  pending(id: string): boolean {
    return this.chains.has(id)
  }
}
