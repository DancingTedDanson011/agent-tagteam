// Grabs the rendered content of a (possibly occluded) window via PrintWindow.
// PrintWindow talks to the target window, so it runs on a worker thread (see async.ts).
import * as w from './api'
import type { HWND } from './api'
import { printWindow } from './async'
import { getRect } from './windows'

const PW_RENDERFULLCONTENT = 0x2
const DIB_RGB_COLORS = 0
const BI_RGB = 0
/** Larger than any real screen; guards the bitmap allocation against a bogus window rect. */
const MAX_SIDE = 16384

export type Snapshot = { width: number; height: number; bgra: Uint8Array }

export async function snapshotWindow(hwnd: HWND): Promise<Snapshot | null> {
  const r = getRect(hwnd)
  if (!r) return null
  const width = r.right - r.left
  const height = r.bottom - r.top
  if (width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE) return null

  const screenDc = w.GetDC(0n)
  if (!screenDc) return null
  const memDc = w.CreateCompatibleDC(screenDc)
  const bmp = w.CreateCompatibleBitmap(screenDc, width, height)
  try {
    if (!memDc || !bmp) return null
    const old = w.SelectObject(memDc, bmp)
    const ok = (await printWindow(hwnd, memDc, PW_RENDERFULLCONTENT)) !== 0
    w.SelectObject(memDc, old)
    if (!ok) return null
    const bgra = new Uint8Array(width * height * 4)
    const bmi = {
      biSize: w.koffi.sizeof(w.BITMAPINFOHEADER),
      biWidth: width,
      biHeight: -height, // top-down rows
      biPlanes: 1,
      biBitCount: 32,
      biCompression: BI_RGB,
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0
    }
    const lines = w.GetDIBits(memDc, bmp, 0, height, bgra, bmi, DIB_RGB_COLORS)
    return lines === height ? { width, height, bgra } : null
  } finally {
    if (bmp) w.DeleteObject(bmp)
    if (memDc) w.DeleteDC(memDc)
    w.ReleaseDC(0n, screenDc)
  }
}
