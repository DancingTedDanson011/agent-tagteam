// The command line an agent tile is started with, checked against a REAL Windows process: whatever
// the task text contains, it must arrive as one argument (cold review: node-pty's own quoting let a
// task wrapped in quotes split into extra flags, e.g. --dangerously-skip-permissions).
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { commandTail } from './agents'

// windowsVerbatimArguments: the tail reaches the process exactly as built, like node-pty passes it.
const argvOf = (tail: string): string[] => {
  const r = spawnSync(process.execPath, ['-e', '"console.log(JSON.stringify(process.argv.slice(1)))"', '--', tail], {
    windowsVerbatimArguments: true,
    argv0: 'node', // the verbatim line starts with argv0 unquoted; the real path has a space
    encoding: 'utf8'
  })
  if (r.status !== 0) throw new Error(`probe failed (${r.status}): ${r.stderr}`)
  return JSON.parse(r.stdout.trim())
}

describe('commandTail', () => {
  it.each([
    ['a task wrapped in quotes', '"fix it" --dangerously-skip-permissions --allowedTools Bash "'],
    ['a task with backslashes before a quote', 'C:\\dir\\" --flag'],
    ['a multi-line task', 'line one\nline two --x'],
    ['an empty argument', '']
  ])('%s arrives as exactly one argument', (_label, task) => {
    expect(argvOf(commandTail(['--append-system-prompt', 'PROMPT', task]))).toEqual(['--append-system-prompt', 'PROMPT', task])
  })

  it('counter-check: node-pty\'s own quoting does split such a task (why commandTail exists)', async () => {
    const { argsToCommandLine } = createRequire(import.meta.url)('node-pty/lib/windowsPtyAgent.js') as {
      argsToCommandLine: (file: string, args: string[]) => string
    }
    const task = '"fix it" --dangerously-skip-permissions "'
    const tail = argsToCommandLine('x', [task]).slice(2) // drop the file part "x "
    expect(argvOf(tail)).toContain('--dangerously-skip-permissions')
  })
})
