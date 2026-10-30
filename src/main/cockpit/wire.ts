import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { parseCockpitCommand } from '../../shared/cockpit'
import { CockpitController } from './controller'

type Options = NonNullable<ConstructorParameters<typeof CockpitController>[1]>

export function wireCockpit(window: BrowserWindow, directory: string, options: Options = {}) {
  const push = () => { if (!window.isDestroyed()) window.webContents.send('cockpit', controller.snapshot()) }
  const controller = new CockpitController(directory, { ...options, onChange: () => { options.onChange?.(); push() } })
  const allowed = (event: IpcMainInvokeEvent) => !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
  ipcMain.handle('cockpit:load', async event => {
    if (!allowed(event)) throw new Error('Cockpit sender frame is not allowed')
    await controller.tick()
    return controller.snapshot()
  })
  ipcMain.handle('cockpit:command', async (event, raw: unknown) => {
    if (!allowed(event)) return { ok: false, error: 'Cockpit sender frame is not allowed' }
    const command = parseCockpitCommand(raw)
    return command ? controller.command(command) : { ok: false, error: 'Invalid cockpit request' }
  })
  return { tick: () => controller.tick(), push, mcp: controller.mcp, snapshot: () => controller.snapshot(),
    async close() {
      ipcMain.removeHandler('cockpit:load')
      ipcMain.removeHandler('cockpit:command')
      await controller.close()
    }
  }
}
