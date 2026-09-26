// Starts a real console window for a workspace slot and finds exactly that window once it is on screen.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { SessionStyle, SlotLaunch, WindowRun } from '../../shared/types'
import { findOnPath } from '../agents/programs'
import * as w from '../win32/api'
import type { HWND } from '../win32/api'
import { launchVisible, systemDirectory } from '../win32/launch'
import { parentPid } from '../win32/process-cwd'
import * as win from '../win32/windows'
import { commandPath, conhostCommandLine, wtArgs } from './recipe'

type WindowLaunch = Extract<SlotLaunch, { kind: 'window' }>

export const windowClassOf = (launch: WindowLaunch): string =>
  launch.host === 'wt' ? 'CASCADIA_HOSTING_WINDOW_CLASS' : 'ConsoleWindowClass'

function shortPath(p: string): string | null {
  const src = new Uint16Array(p.length + 1)
  for (let i = 0; i < p.length; i++) src[i] = p.charCodeAt(i)
  const buf = new Uint16Array(1024)
  const len = w.GetShortPathNameW(src, buf, buf.length)
  return len > 0 && len < buf.length ? String.fromCharCode(...buf.subarray(0, len)) : null
}

/** An agent CLI by its absolute path from PATH (never a bare name: that searches the working folder first). */
function runPath(run: WindowRun | undefined): string | null {
  if (!run) return null
  const path = process.env.PATH ?? ''
  return commandPath(findOnPath(`${run}.exe`, path) ?? findOnPath(`${run}.cmd`, path), shortPath)
}

function shellPath(shell: Extract<WindowLaunch, { host: 'conhost' }>['shell']): string | null {
  const sys = systemDirectory()
  if (shell === 'cmd') return join(sys, 'cmd.exe')
  if (shell === 'powershell') return join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return findOnPath('pwsh.exe', process.env.PATH ?? '')
}

/**
 * Starts the window. Returns how to recognize it (null: could not start). `cwd` is an existing
 * absolute folder. A classic console is recognized by its process's parent (the conhost.exe started
 * here); a Windows Terminal window by the title it was given — all its windows share one process.
 */
export function startWindow(launch: WindowLaunch, cwd: string, style: SessionStyle, resume: boolean): ((h: HWND) => boolean) | null {
  if (launch.host === 'conhost') {
    const shell = shellPath(launch.shell)
    if (!shell) return null
    const conhost = join(systemDirectory(), 'conhost.exe')
    const pid = launchVisible(conhost, conhostCommandLine(launch, resume, { shell, run: runPath(launch.run) }), cwd)
    return pid === null ? null : (h) => parentPid(win.getPid(h)) === pid
  }
  const args = wtArgs(launch, cwd, style, resume, { cmd: join(systemDirectory(), 'cmd.exe'), run: runPath(launch.run) })
  if (!args) return null
  try {
    // wt.exe is an app execution alias: it hands the window to Windows Terminal and exits.
    spawn('wt.exe', args, { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref()
  } catch {
    return null
  }
  // Without a name there is nothing to tell it by: the first new Windows Terminal window is taken.
  return style.label ? (h) => win.getTitle(h) === style.label : () => true
}

/** The first new visible window of `cls` that was not there `before` and is ours, or null after `timeoutMs`. */
export async function waitForNewWindow(before: Set<HWND>, cls: string, ours: (h: HWND) => boolean, timeoutMs: number): Promise<HWND | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = win.listConsoleWindows().find((h) => !before.has(h) && win.getClassName(h) === cls && ours(h))
    if (found) return found
    await new Promise((r) => setTimeout(r, 150))
  }
  return null
}
