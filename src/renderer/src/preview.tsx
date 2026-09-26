// Design preview: the real UI in a plain browser, with a stand-in for the Electron bridge and
// clearly fake sample sessions. Used only for the design proof (vite.preview.config.ts), never
// part of the app build.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { OrganizerApi, SessionInfo, Workspace } from '../../shared/types'
import { App } from './App'
import './styles.css'

const sessions: SessionInfo[] = [
  { id: '101', title: '◐ Vorschau: Agent arbeitet', className: 'X', processName: 'WindowsTerminal.exe', alive: true, activity: 'working', badge: false },
  { id: '102', title: '✳ Vorschau: Agent wartet', className: 'X', processName: 'WindowsTerminal.exe', alive: true, activity: 'waiting', badge: true },
  { id: '103', title: 'Vorschau: cmd bereit', className: 'X', processName: 'cmd.exe', alive: true, activity: 'idle', badge: false, label: 'Vorschau: Build', color: 'green' },
  { id: 'a1', title: '✳ Vorschau: Orchestrator', className: 'agent', processName: 'claude', alive: true, activity: 'idle', badge: false,
    agent: { provider: 'claude', role: 'orchestrator', parentId: null, cwd: 'C:\\Vorschau', exited: false, unlocked: false, asksTrust: false } },
  { id: 'a2', title: 'Vorschau: Codex-Worker', className: 'agent', processName: 'codex', alive: true, activity: 'working', badge: false,
    agent: { provider: 'codex', role: 'worker', parentId: 'a1', cwd: 'C:\\Vorschau', exited: false, unlocked: false, asksTrust: false } }
]
const agentText: Record<string, string> = {
  a1: 'Vorschau: Orchestrator\r\n> spawn_worker codex …\r\n> wait_for_idle a2\r\n',
  a2: 'Vorschau: Codex-Worker\r\nRunning tests …\r\nRESULT: 12 passed\r\n'
}
let workspaces: Workspace[] = [{ id: 'w1', name: 'Vorschau-Workspace', view: 'grid', slots: [] }]

const mock: OrganizerApi = {
  onSessions: (cb) => {
    setTimeout(() => cb(new URLSearchParams(location.search).has('empty') ? [] : sessions), 0)
    return () => undefined
  },
  onDrag: () => () => undefined,
  onCaptured: () => () => undefined,
  onNotice: (cb) => {
    if (new URLSearchParams(location.search).has('notice')) setTimeout(() => cb('elevated'), 0)
    return () => undefined
  },
  ready: () => undefined,
  setLayout: () => undefined,
  capture: async (hwnd) => ({ ok: true, id: hwnd }),
  release: async () => undefined,
  focusSession: () => undefined,
  clearBadge: () => undefined,
  listCandidates: async () => [
    { hwnd: '9', title: 'Vorschau: PowerShell', className: 'X', processName: 'powershell.exe' },
    { hwnd: '10', title: 'Vorschau: cmd', className: 'X', processName: 'cmd.exe' },
    { hwnd: '11', title: 'Vorschau: anderer Organizer', className: 'X', processName: 'WindowsTerminal.exe', heldBy: 'instance' },
    { hwnd: '12', title: 'Vorschau: alte Version', className: 'X', processName: 'WindowsTerminal.exe', heldBy: 'legacy' }
  ],
  loadWorkspaces: async () => workspaces,
  saveWorkspaces: async (list) => {
    workspaces = list
    return true
  },
  setSessionStyle: () => undefined,
  describeSessions: async (ids) => ({
    home: 'C:\\Users\\Vorschau',
    recipes: Object.fromEntries(
      ids.map((id) => [
        id,
        id === '103'
          ? { kind: 'window', host: 'conhost', shell: 'cmd', cwd: 'C:\\Vorschau\\Projekt' }
          : id.startsWith('a1')
            ? { kind: 'agent', provider: 'claude', role: 'orchestrator', cwd: 'C:\\Vorschau' }
            : id.startsWith('10')
              ? { kind: 'window', host: 'wt', cwd: null, run: 'claude' }
              : null
      ])
    )
  }),
  restoreSlot: async () => ({ ok: false, reason: 'failed' }),
  windowControl: () => undefined,
  reseat: () => undefined,
  newInstance: () => undefined,
  loadLang: async () => (new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'de'),
  saveLang: async () => true,
  availableAgents: async () => ['claude', 'codex', 'cmd', 'pwsh'],
  pickFolder: async () => 'C:\\Vorschau\\Projekt',
  startAgent: async () => ({ ok: false, error: 'preview' }),
  onAgentData: (cb) => {
    setTimeout(() => Object.entries(agentText).forEach(([id, data]) => cb({ id, data })), 0)
    return () => undefined
  },
  agentInput: () => undefined,
  agentResize: () => undefined,
  stopAgent: () => undefined,
  removeAgent: () => undefined,
  unlockAgent: () => undefined,
  startShell: async (provider, folder) => (folder.trim() === 'x' ? { ok: false, error: 'bad-cwd', detail: folder } : { ok: true, id: `a-${provider}` }),
  clipboardRead: async () => 'Vorschau-Zwischenablage',
  clipboardWrite: () => undefined,
  voiceSettings: async () => ({ key: '-', lang: 'auto', model: 'large-v3-turbo' }),
  saveVoiceSettings: async (s) => s,
  transcribe: async () => ({ ok: true, text: 'Vorschau: diktierter Text' })
}
window.organizer = mock

// ?lang=en  ?view=grid|free|tabs  ?dock=1  ?dialog=picker|workspaces  ?empty  ?notice — preview states for the design proof
const params = new URLSearchParams(location.search)
setTimeout(() => {
  const key = { focus: '1', grid: '2', free: '3', tabs: '4' }[params.get('view') ?? '']
  if (key) window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true }))
  setTimeout(() => {
    if (params.has('dock')) document.querySelector<HTMLButtonElement>('.tile .session-actions button')?.click()
    const dialog = params.get('dialog')
    if (dialog === 'picker') document.querySelector<HTMLButtonElement>('.button.is-primary')?.click()
    if (dialog === 'workspaces') document.querySelector<HTMLButtonElement>('.button.is-quiet')?.click()
  }, 50)
}, 50)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
