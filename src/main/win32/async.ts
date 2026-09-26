// Calls that change a FOREIGN window (style, owner, show, position) block the calling thread
// while that window's thread is hung — measured 5.6 s against a window stuck in Sleep(6000).
// They therefore run on a koffi worker thread, never on the app's main thread.
import * as w from './api'
import type { HWND, WindowPlacement } from './api'

type AsyncCapable = { async: (...args: unknown[]) => void }

function call<T>(fn: AsyncCapable, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    fn.async(...args, (err: unknown, res: T) => (err ? reject(err) : resolve(res)))
  })
}

export const setWindowLong = (h: HWND, index: number, value: number | bigint): Promise<number | bigint> =>
  call(w.SetWindowLongPtrW, h, index, value)

export const setWindowPos = (
  h: HWND,
  after: HWND,
  x: number,
  y: number,
  cx: number,
  cy: number,
  flags: number
): Promise<number> => call(w.SetWindowPos, h, after, x, y, cx, cy, flags)

export const showWindow = (h: HWND, cmd: number): Promise<number> => call(w.ShowWindow, h, cmd)

export const setWindowPlacement = (h: HWND, wp: WindowPlacement): Promise<number> =>
  call(w.SetWindowPlacement, h, wp)

export const printWindow = (h: HWND, dc: unknown, flags: number): Promise<number> =>
  call(w.PrintWindow, h, dc, flags)

export const setForeground = (h: HWND): Promise<number> => call(w.SetForegroundWindow, h)

export const isHung = (h: HWND): boolean => w.IsHungAppWindow(h) !== 0
