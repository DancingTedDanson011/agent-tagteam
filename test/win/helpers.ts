// Spawns and cleans up throwaway console windows for integration tests.
// Only windows spawned here are ever touched — never the user's own sessions.
import { spawn } from 'node:child_process'
import * as w from '../../src/main/win32/api'
import * as win from '../../src/main/win32/windows'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const spawned = new Set<bigint>()

async function waitForNewWindow(before: Set<bigint>, cls: string): Promise<bigint> {
  for (let i = 0; i < 75; i++) {
    const found = win.listConsoleWindows().find((h) => !before.has(h) && win.getClassName(h) === cls)
    if (found) {
      spawned.add(found)
      await sleep(300) // let the window finish its first layout
      return found
    }
    await sleep(200)
  }
  throw new Error(`no new ${cls} window appeared`)
}

export async function openConhost(tag: string, command = `echo ${tag}`): Promise<bigint> {
  const before = new Set(win.listTopLevelWindows())
  spawn('cmd.exe', ['/c', 'start', `"${tag}"`, 'conhost.exe', 'cmd.exe', '/k', command], { stdio: 'ignore' }).unref()
  return waitForNewWindow(before, 'ConsoleWindowClass')
}

export async function openTerminal(command: string): Promise<bigint> {
  const before = new Set(win.listTopLevelWindows())
  spawn('wt.exe', ['-w', 'new', 'cmd.exe', '/k', command], { stdio: 'ignore' }).unref()
  return waitForNewWindow(before, 'CASCADIA_HOSTING_WINDOW_CLASS')
}

export function closeSpawned(): void {
  for (const h of spawned) {
    if (win.isWindow(h)) w.PostMessageW(h, 0x0010, 0n, 0n) // WM_CLOSE
  }
  spawned.clear()
}

export function windowState(h: bigint) {
  return {
    style: win.getStyle(h),
    exStyle: win.getExStyle(h),
    rect: win.getRect(h),
    zoomed: w.IsZoomed(h) !== 0,
    owner: Number(w.GetWindowLongPtrW(h, win.GWLP_HWNDPARENT))
  }
}
