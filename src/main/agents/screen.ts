// A headless terminal per agent tile: what the screen shows, independent of the page. Ported from
// Marco's bridge (packages/bridged/src/headless-term.ts, MIT): buffer rows are absolute — the
// visible screen is [baseY, baseY + rows), which bridge's audit (C1) found the hard way.
import { createHash } from 'node:crypto'
import xtermHeadless from '@xterm/headless'

const { Terminal } = xtermHeadless
const SCROLLBACK = 5000
// Spinner and progress glyphs: two frames of the same animation hash alike (bridge audit M11).
const ANIM_CHARS = /[⠀-⣿▀-▟•·*✦◆●○◐◑◒◓▰▱✳]/g

export class Screen {
  private readonly term: InstanceType<typeof Terminal>
  title = ''

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
    this.term.onTitleChange((t) => {
      this.title = t
    })
  }

  /** Resolves once xterm has parsed the data (its parser is asynchronous). */
  write(data: string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve))
  }

  resize(cols: number, rows: number): void {
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows)
  }

  private line(y: number): string {
    return this.term.buffer.active.getLine(y)?.translateToString(true) ?? ''
  }

  visibleLines(): string[] {
    const base = this.term.buffer.active.baseY
    return Array.from({ length: this.term.rows }, (_, i) => this.line(base + i))
  }

  /**
   * The last `n` written lines of scrollback + screen. The window ends at the last non-empty row:
   * the rows below the output are empty screen, and counting them would return nothing at all.
   */
  tail(n: number): string {
    let end = this.term.buffer.active.length - 1
    while (end >= 0 && this.line(end).trim() === '') end--
    const lines: string[] = []
    for (let y = Math.max(0, end - n + 1); y <= end; y++) lines.push(this.line(y))
    return lines.join('\n')
  }

  /** Hash of the visible screen with animation glyphs masked: equal while only a spinner moves. */
  hash(): string {
    return createHash('sha1')
      .update(this.visibleLines().map((l) => l.replace(ANIM_CHARS, ' ')).join('\n'))
      .digest('hex')
  }

  dispose(): void {
    this.term.dispose()
  }
}
