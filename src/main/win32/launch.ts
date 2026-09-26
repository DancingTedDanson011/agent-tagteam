// Starts a process that is fully independent of this one: no inherited handles, no handle kept,
// not part of libuv's kill-on-close job (Node's non-detached children are), own hidden console.
// Node's `detached` is not an option for PowerShell: without a console it never ran the script (measured).
import * as w from './api'

const CREATE_NO_WINDOW = 0x08000000
const CREATE_NEW_PROCESS_GROUP = 0x00000200

/** Quotes one argument for the Windows command line (MSVCRT rules). */
export function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
    } else {
      out += '\\'.repeat(backslashes) + ch
      backslashes = 0
    }
  }
  return out + '\\'.repeat(backslashes * 2) + '"'
}

export function buildCommandLine(file: string, args: string[]): string {
  return [file, ...args].map(quoteArg).join(' ')
}

function wide(text: string): Uint16Array {
  const buf = new Uint16Array(text.length + 1) // zero-terminated
  for (let i = 0; i < text.length; i++) buf[i] = text.charCodeAt(i)
  return buf
}

/** The Windows system directory (e.g. C:\Windows\System32), from the OS rather than an env var. */
export function systemDirectory(): string {
  const buf = new Uint16Array(512)
  const len = w.GetSystemDirectoryW(buf, buf.length)
  if (len === 0 || len >= buf.length) throw new Error('GetSystemDirectoryW failed')
  return String.fromCharCode(...buf.subarray(0, len))
}

/**
 * Starts `exePath` (an ABSOLUTE path, passed as lpApplicationName so Windows does no search in the
 * app or working directory). Returns the new process id, or null when it could not be created.
 */
/** A drive path (C:\...) or a UNC path (\\server\share\...): nothing Windows would search for. */
export function isAbsoluteWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:\\/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)
}

const CREATE_NEW_CONSOLE = 0x00000010

/**
 * Starts `exePath` with a console window of its own, in `cwd`. `commandLine` is passed as is: callers
 * build it from fixed words only (see restore/recipe.ts). Returns the process id, or null.
 */
export function launchVisible(exePath: string, commandLine: string, cwd: string): number | null {
  if (!isAbsoluteWindowsPath(exePath) || !isAbsoluteWindowsPath(cwd)) throw new Error('launchVisible needs absolute paths')
  const si = {
    cb: w.koffi.sizeof(w.STARTUPINFOW),
    lpReserved: null,
    lpDesktop: null,
    lpTitle: null,
    dwX: 0,
    dwY: 0,
    dwXSize: 0,
    dwYSize: 0,
    dwXCountChars: 0,
    dwYCountChars: 0,
    dwFillAttribute: 0,
    dwFlags: 0,
    wShowWindow: 0,
    cbReserved2: 0,
    lpReserved2: null,
    hStdInput: null,
    hStdOutput: null,
    hStdError: null
  }
  const pi = { hProcess: null as unknown, hThread: null as unknown, dwProcessId: 0, dwThreadId: 0 }
  const ok = w.CreateProcessW(wide(exePath), wide(commandLine), null, null, 0, CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP, null, wide(cwd), si, pi)
  if (!ok) return null
  w.CloseHandle(pi.hThread)
  w.CloseHandle(pi.hProcess)
  return pi.dwProcessId
}

export function launchIndependent(exePath: string, args: string[]): number | null {
  if (!isAbsoluteWindowsPath(exePath)) throw new Error(`launchIndependent needs an absolute path, got ${exePath}`)
  const buf = wide(buildCommandLine(exePath, args))
  const si = {
    cb: w.koffi.sizeof(w.STARTUPINFOW),
    lpReserved: null,
    lpDesktop: null,
    lpTitle: null,
    dwX: 0,
    dwY: 0,
    dwXSize: 0,
    dwYSize: 0,
    dwXCountChars: 0,
    dwYCountChars: 0,
    dwFillAttribute: 0,
    dwFlags: 0,
    wShowWindow: 0,
    cbReserved2: 0,
    lpReserved2: null,
    hStdInput: null,
    hStdOutput: null,
    hStdError: null
  }
  const pi = { hProcess: null as unknown, hThread: null as unknown, dwProcessId: 0, dwThreadId: 0 }
  const ok = w.CreateProcessW(wide(exePath), buf, null, null, 0, CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, null, null, si, pi)
  if (!ok) return null
  w.CloseHandle(pi.hThread)
  w.CloseHandle(pi.hProcess)
  return pi.dwProcessId
}
