// Higher-level window helpers on top of the raw bindings.
import * as w from './api'
import type { HWND, Rect } from './api'

export const GWL_STYLE = -16
export const GWL_EXSTYLE = -20
export const GWLP_HWNDPARENT = -8

export const WS_CAPTION = 0x00c00000
export const WS_THICKFRAME = 0x00040000
export const WS_EX_TOOLWINDOW = 0x00000080
export const WS_EX_APPWINDOW = 0x00040000

export const SWP_NOSIZE = 0x0001
export const SWP_NOMOVE = 0x0002
export const SWP_NOZORDER = 0x0004
export const SWP_NOACTIVATE = 0x0010
export const SWP_FRAMECHANGED = 0x0020
export const SWP_SHOWWINDOW = 0x0040

export const SW_HIDE = 0
export const SW_SHOWNORMAL = 1
export const SW_SHOWNOACTIVATE = 4

export const HWND_BOTTOM = 1n

export const CONSOLE_CLASSES = ['ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS'] as const

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x0008
const TOKEN_ELEVATION_CLASS = 20
const GA_ROOT = 2

function readWide(buf: Uint16Array, len: number): string {
  return String.fromCharCode(...buf.subarray(0, Math.max(0, len)))
}

export function getClassName(hwnd: HWND): string {
  const buf = new Uint16Array(256)
  return readWide(buf, w.GetClassNameW(hwnd, buf, buf.length))
}

export function getTitle(hwnd: HWND): string {
  const buf = new Uint16Array(512)
  return readWide(buf, w.GetWindowTextW(hwnd, buf, buf.length))
}

export function getPid(hwnd: HWND): number {
  const pid = [0]
  w.GetWindowThreadProcessId(hwnd, pid)
  return pid[0]
}

export function isWindow(hwnd: HWND): boolean {
  return w.IsWindow(hwnd) !== 0
}

export function isVisible(hwnd: HWND): boolean {
  return w.IsWindowVisible(hwnd) !== 0
}

export function isMinimized(hwnd: HWND): boolean {
  return w.IsIconic(hwnd) !== 0
}

export function getRect(hwnd: HWND): Rect | null {
  const r: Rect = { left: 0, top: 0, right: 0, bottom: 0 }
  return w.GetWindowRect(hwnd, r) !== 0 ? r : null
}

export function getStyle(hwnd: HWND): number {
  return Number(w.GetWindowLongPtrW(hwnd, GWL_STYLE))
}

export function getExStyle(hwnd: HWND): number {
  return Number(w.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
}

export function setStyle(hwnd: HWND, style: number): void {
  w.SetWindowLongPtrW(hwnd, GWL_STYLE, style)
}

export function setExStyle(hwnd: HWND, exStyle: number): void {
  w.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle)
}

export function getPlacement(hwnd: HWND): w.WindowPlacement | null {
  const wp: w.WindowPlacement = {
    length: w.koffi.sizeof(w.WINDOWPLACEMENT),
    flags: 0,
    showCmd: 0,
    ptMinPosition: { x: 0, y: 0 },
    ptMaxPosition: { x: 0, y: 0 },
    rcNormalPosition: { left: 0, top: 0, right: 0, bottom: 0 }
  }
  return w.GetWindowPlacement(hwnd, wp) !== 0 ? wp : null
}

export function rootOf(hwnd: HWND): HWND {
  const root = w.GetAncestor(hwnd, GA_ROOT) as HWND | null
  return root ?? hwnd
}

export function cursorPos(): { x: number; y: number } {
  const p = { x: 0, y: 0 }
  w.GetCursorPos(p)
  return p
}

/** Process creation time as a decimal string; guards against HWND/PID reuse. */
export function processStartTime(pid: number): string | null {
  const h = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!h) return null
  try {
    const c = { low: 0, high: 0 }
    const ignored = () => ({ low: 0, high: 0 }) // exit/kernel/user times are required out-params
    if (w.GetProcessTimes(h, c, ignored(), ignored(), ignored()) === 0) return null
    return ((BigInt(c.high) << 32n) | BigInt(c.low)).toString()
  } finally {
    w.CloseHandle(h)
  }
}

export function processImageName(pid: number): string | null {
  const h = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!h) return null
  try {
    const buf = new Uint16Array(1024)
    const size = [buf.length]
    if (w.QueryFullProcessImageNameW(h, 0, buf, size) === 0) return null
    const full = readWide(buf, size[0])
    return full.slice(full.lastIndexOf('\\') + 1)
  } finally {
    w.CloseHandle(h)
  }
}

/** True when the process runs elevated, or when we are not allowed to ask (treated as elevated). */
export function isProcessElevated(pid: number): boolean {
  const h = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!h) return true
  try {
    const token = [null as unknown]
    if (w.OpenProcessToken(h, TOKEN_QUERY, token) === 0 || !token[0]) return true
    try {
      const elevation = [0]
      const written = [0]
      if (w.GetTokenInformation(token[0], TOKEN_ELEVATION_CLASS, elevation, 4, written) === 0) return true
      return elevation[0] !== 0
    } finally {
      w.CloseHandle(token[0])
    }
  } finally {
    w.CloseHandle(h)
  }
}

export function isConsoleWindow(hwnd: HWND): boolean {
  return (CONSOLE_CLASSES as readonly string[]).includes(getClassName(hwnd))
}

export function listTopLevelWindows(): HWND[] {
  const result: HWND[] = []
  const cb = w.koffi.register((hwnd: HWND) => {
    result.push(hwnd)
    return 1
  }, w.koffi.pointer(w.EnumWindowsProc))
  try {
    w.EnumWindows(cb, 0)
  } finally {
    w.koffi.unregister(cb)
  }
  return result
}

/**
 * The topmost visible, not minimized top-level window at `pt` (screen pixels) among those `consider`
 * accepts. Only a chosen set: invisible overlays (game overlays, cloaked apps) also count as
 * "visible" top-level windows and would otherwise sit on top of everything.
 */
export function windowAt(pt: { x: number; y: number }, consider: (h: HWND) => boolean): HWND | null {
  // EnumWindows walks the z-order from the top.
  for (const h of listTopLevelWindows()) {
    if (!isVisible(h) || isMinimized(h)) continue
    const r = getRect(h)
    if (r && pt.x >= r.left && pt.x < r.right && pt.y >= r.top && pt.y < r.bottom && consider(h)) return h
  }
  return null
}

export function listConsoleWindows(): HWND[] {
  return listTopLevelWindows().filter((h) => isVisible(h) && isConsoleWindow(h))
}
