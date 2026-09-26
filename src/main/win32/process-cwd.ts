// The working folder of another process, read from its PEB (read-only). Used to write a captured
// console window's folder into a workspace. x64 layout, the only one this app ships for:
// PROCESS_BASIC_INFORMATION.PebBaseAddress at 8 · PEB.ProcessParameters at 0x20 ·
// RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath (UNICODE_STRING) at 0x38: Length u16, Buffer at +8.
// Measured in the 2026-09-25 spike: cmd after `cd` and PowerShell (its start folder) read correctly.
import * as w from './api'

const PROCESS_QUERY_INFORMATION = 0x0400
const PROCESS_VM_READ = 0x0010
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const MAX_PATH_BYTES = 32767 * 2

function read(h: unknown, addr: bigint, size: number): Buffer | null {
  const buf = new Uint8Array(size)
  const got = [0]
  if (!w.ReadProcessMemory(h, addr, buf, size, got) || Number(got[0]) !== size) return null
  return Buffer.from(buf)
}

/** The process that started `pid` (PROCESS_BASIC_INFORMATION.InheritedFromUniqueProcessId at 40), or null. */
export function parentPid(pid: number): number | null {
  const h = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!h) return null
  try {
    const pbi = new Uint8Array(48)
    if (w.NtQueryInformationProcess(h, 0, pbi, pbi.length, [0]) !== 0) return null
    return Number(Buffer.from(pbi).readBigUInt64LE(40))
  } finally {
    w.CloseHandle(h)
  }
}

/** null when the process cannot be read (gone, elevated, another user) — never a guess. */
export function processCwd(pid: number): string | null {
  const h = w.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid)
  if (!h) return null
  try {
    const pbi = new Uint8Array(48)
    if (w.NtQueryInformationProcess(h, 0, pbi, pbi.length, [0]) !== 0) return null
    const peb = Buffer.from(pbi).readBigUInt64LE(8)
    const params = read(h, peb + 0x20n, 8)?.readBigUInt64LE(0)
    if (!params) return null
    const dos = read(h, params + 0x38n, 16)
    if (!dos) return null
    const length = dos.readUInt16LE(0)
    if (length === 0 || length > MAX_PATH_BYTES || length % 2) return null
    return read(h, dos.readBigUInt64LE(8), length)?.toString('utf16le') ?? null
  } finally {
    w.CloseHandle(h)
  }
}
