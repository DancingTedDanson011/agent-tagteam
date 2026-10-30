// Types shared between main, preload and renderer. Plain data only (structured-clone safe).
import type { VoiceResult, VoiceSettings } from './voice'
import type { CockpitCommand, CockpitResult, CockpitSnapshot } from './cockpit'

export type Lang = 'de' | 'en'

export type ViewMode = 'free' | 'grid' | 'focus' | 'tabs' | 'cockpit'

export type Activity = 'idle' | 'working' | 'waiting'

/** Programs an agent tile may run (fixed list, see src/main/agents/providers.ts). */
export type AgentProvider = 'claude' | 'codex' | 'opencode' | 'cmd' | 'pwsh'

/** orchestrator: splits work across workers · plain: works itself · worker: started by another tile. Tools: see hasOrganizerTools. */
export type AgentRole = 'orchestrator' | 'worker' | 'plain'

/** resume: only from a workspace restore (main), never from the page. */
export type AgentStart = { provider: AgentProvider; role: AgentRole; cwd: string; task: string; resume?: boolean }

export type SessionInfo = {
  id: string
  title: string
  className: string
  processName: string
  alive: boolean
  activity: Activity
  /** Set when the agent finished or needs input while the user was not looking. */
  badge: boolean
  /** The user dragged, resized, maximized or minimized the window away from its slot. */
  displaced?: boolean
  /** The user's name and colour for this session. */
  label?: string
  color?: ColorId
  /** Agent tiles only: a terminal this app runs itself (ConPTY), not a captured window. */
  agent?: { provider: AgentProvider; role: AgentRole; parentId: string | null; cwd: string; exited: boolean; unlocked: boolean; asksTrust: boolean }
}

/** Rect in CSS pixels relative to the renderer viewport. */
export type SlotRect = { x: number; y: number; width: number; height: number }

export type SlotPlacement =
  // real window positioned over the slot; mirror: also drawn as a preview there (focus view side list)
  | { id: string; mode: 'live'; rect: SlotRect; mirror?: SlotRect; clip?: SlotRect }
  | { id: string; mode: 'thumb'; rect: SlotRect; clip?: SlotRect } // parked, DWM live thumbnail; clip = visible part of its scroll list
  | { id: string; mode: 'parked' } // parked, nothing drawn

/** modal: a dialog is open — every window parks below the app and the app stays in front. */
export type Layout = { placements: SlotPlacement[]; attended: string[]; modal?: boolean }

export type DragKind = 'capture' | 'reseat'

export type DragState = { active: boolean; over: boolean; kind?: DragKind }

/** heldBy: another organizer holds it — this version can take it over; an older version cannot. */
export type CaptureCandidate = { hwnd: string; title: string; className: string; processName: string; heldBy?: 'instance' | 'stale' | 'legacy' }

export type RefusalReason = 'elevated' | 'gone' | 'unsupported' | 'already' | 'other-instance' | 'legacy-instance' | 'stale-instance' | 'handover-timeout' | 'failed'

export type CaptureResult = { ok: true; id: string } | { ok: false; reason: RefusalReason }

export type WorkspaceRule = { processName: string; titleIncludes: string }

export type FreeRect = { x: number; y: number; width: number; height: number }

/** Colours a session can carry (fixed palette, see src/shared/restore.ts). */
export type ColorId = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'violet' | 'pink'

/** The name and colour the user gave a session; shown in every view and kept by workspaces. */
export type SessionStyle = { label?: string; color?: ColorId }

/** Programs an agent CLI inside a restored window can be. */
export type WindowRun = 'claude' | 'codex' | 'opencode'

/**
 * How a workspace brings a window back when it is not open.
 * agent: an agent tile of this app · window: a real console window, started and captured again.
 * cwd null: the folder is unknown (Windows Terminal) — it starts in the user's home folder.
 */
export type SlotLaunch =
  | { kind: 'agent'; provider: AgentProvider; role: 'plain' | 'orchestrator'; cwd: string }
  | { kind: 'window'; host: 'conhost'; shell: 'cmd' | 'powershell' | 'pwsh'; cwd: string | null; run?: WindowRun }
  | { kind: 'window'; host: 'wt'; cwd: string | null; run?: WindowRun }

export type WorkspaceSlot = { rule: WorkspaceRule; free?: FreeRect; label?: string; color?: ColorId; launch?: SlotLaunch }

/** resume: agent CLIs continue their last conversation in the folder (claude --continue, codex resume --last). */
export type Workspace = { id: string; name: string; view: ViewMode; slots: WorkspaceSlot[]; resume?: boolean }

/** What restoring one slot did. */
export type RestoreResult = { ok: true; id: string; homeFallback: boolean } | { ok: false; reason: 'failed' | 'timeout' | 'no-launch' }

export type OrganizerApi = {
  onCockpit(cb: (snapshot: CockpitSnapshot) => void): () => void
  loadCockpit(): Promise<CockpitSnapshot>
  cockpitCommand(command: CockpitCommand): Promise<CockpitResult>
  onSessions(cb: (sessions: SessionInfo[]) => void): () => void
  onDrag(cb: (state: DragState) => void): () => void
  onCaptured(cb: (id: string) => void): () => void
  /** A capture was refused (drag-in); the page words it in the current language. */
  onNotice(cb: (reason: RefusalReason) => void): () => void
  /** The page is mounted and listening; main pushes the current state. */
  ready(): void
  setLayout(layout: Layout): void
  capture(hwnd: string): Promise<CaptureResult>
  release(id: string): Promise<void>
  focusSession(id: string): void
  clearBadge(id: string): void
  listCandidates(): Promise<CaptureCandidate[]>
  loadWorkspaces(): Promise<Workspace[]>
  saveWorkspaces(list: Workspace[]): Promise<boolean>
  /** Name and colour of a session ({} clears both). */
  setSessionStyle(id: string, style: SessionStyle): void
  /** How each session would come back from a workspace (null: it cannot), and the home folder (for `~`). */
  describeSessions(ids: string[]): Promise<{ home: string; recipes: Record<string, SlotLaunch | null> }>
  /** Starts a workspace slot's missing window or tile and captures it. */
  restoreSlot(slot: WorkspaceSlot, resume: boolean): Promise<RestoreResult>
  windowControl(action: 'minimize' | 'maximize' | 'close'): void
  /** Puts dragged-out windows back into their slots (all when no ids). */
  reseat(ids?: string[]): void
  /** Starts another, independent organizer window. */
  newInstance(): void
  /** The language to start in (override, saved choice or Windows language). */
  loadLang(): Promise<Lang>
  /** Remembers the user's choice; false when it could not be written. */
  saveLang(lang: Lang): Promise<boolean>
  /** Agent tiles: programs found on this machine, starting one, and its terminal stream. */
  availableAgents(): Promise<AgentProvider[]>
  pickFolder(): Promise<string | null>
  startAgent(start: AgentStart): Promise<{ ok: true; id: string } | { ok: false; error: string; detail?: string }>
  onAgentData(cb: (chunk: { id: string; data: string }) => void): () => void
  agentInput(id: string, data: string): void
  agentResize(id: string, cols: number, rows: number): void
  stopAgent(id: string): void
  removeAgent(id: string): void
  unlockAgent(id: string, unlocked: boolean): void
  /** Quick-launch bar: a shell in a pasted folder (empty = home). */
  startShell(provider: 'cmd' | 'pwsh', folder: string): Promise<{ ok: true; id: string } | { ok: false; error: string; detail?: string }>
  clipboardRead(): Promise<string>
  clipboardWrite(text: string): void
  /** Voice input: its settings, and one dictation typed into tile `target` (never with Enter). */
  voiceSettings(): Promise<VoiceSettings>
  saveVoiceSettings(settings: VoiceSettings): Promise<VoiceSettings>
  transcribe(audio: Uint8Array, target: string): Promise<VoiceResult>
}
