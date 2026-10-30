// The only bridge between the page and the main process.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { OrganizerApi } from '../shared/types'

function listen<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => cb(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: OrganizerApi = {
  onCockpit: (cb) => listen('cockpit', cb),
  loadCockpit: () => ipcRenderer.invoke('cockpit:load'),
  cockpitCommand: (command) => ipcRenderer.invoke('cockpit:command', command),
  onSessions: (cb) => listen('sessions', cb),
  onDrag: (cb) => listen('drag', cb),
  onCaptured: (cb) => listen('captured', cb),
  onNotice: (cb) => listen('notice', cb),
  ready: () => ipcRenderer.send('ready'),
  setLayout: (layout) => ipcRenderer.send('layout', layout),
  capture: (hwnd) => ipcRenderer.invoke('capture', hwnd),
  release: (id) => ipcRenderer.invoke('release', id),
  focusSession: (id) => ipcRenderer.send('focus-session', id),
  clearBadge: (id) => ipcRenderer.send('clear-badge', id),
  listCandidates: () => ipcRenderer.invoke('candidates'),
  loadWorkspaces: () => ipcRenderer.invoke('workspaces:load'),
  saveWorkspaces: (list) => ipcRenderer.invoke('workspaces:save', list),
  setSessionStyle: (id, style) => ipcRenderer.send('session:style', id, style),
  describeSessions: (ids) => ipcRenderer.invoke('workspaces:describe', ids),
  restoreSlot: (slot, resume) => ipcRenderer.invoke('workspaces:restore', slot, resume),
  windowControl: (action) => ipcRenderer.send('window', action),
  reseat: (ids) => ipcRenderer.send('reseat', ids),
  newInstance: () => ipcRenderer.send('new-instance'),
  loadLang: () => ipcRenderer.invoke('settings:load'),
  saveLang: (lang) => ipcRenderer.invoke('settings:save', lang),
  availableAgents: () => ipcRenderer.invoke('agents:available'),
  pickFolder: () => ipcRenderer.invoke('agents:pick-folder'),
  startAgent: (start) => ipcRenderer.invoke('agents:start', start),
  onAgentData: (cb) => listen('agent-data', cb),
  agentInput: (id, data) => ipcRenderer.send('agents:input', { id, data }),
  agentResize: (id, cols, rows) => ipcRenderer.send('agents:resize', { id, cols, rows }),
  stopAgent: (id) => ipcRenderer.send('agents:stop', id),
  removeAgent: (id) => ipcRenderer.send('agents:remove', id),
  unlockAgent: (id, unlocked) => ipcRenderer.send('agents:unlock', { id, unlocked }),
  startShell: (provider, folder) => ipcRenderer.invoke('agents:start-shell', { provider, folder }),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  voiceSettings: () => ipcRenderer.invoke('voice:settings:load'),
  saveVoiceSettings: (settings) => ipcRenderer.invoke('voice:settings:save', settings),
  transcribe: (audio, target) => ipcRenderer.invoke('voice:transcribe', audio, target)
}

contextBridge.exposeInMainWorld('organizer', api)
