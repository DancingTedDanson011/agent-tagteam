// Deliberately fake browser-only design data. Imported only by preview.tsx, never by the app.
import type { CockpitCommand, CockpitResult, CockpitSnapshot, ContractDocument } from '../../shared/cockpit'

export function createCockpitPreview(params: URLSearchParams) {
  const at = new Date().toISOString()
  const document: ContractDocument = {
    contract_id: 'C-preview', project: 'Vorschau-Projekt', title: 'Vorschau: Belegbarer Abschluss', status: 'frozen',
    objective: 'Vorschau: Ein Projekt mit klaren Aufgaben und ausgeführten Nachweisen abschließen.',
    non_goals: [], budget: { max_sessions: 2, max_hours: 2, stop_when_exceeded: true },
    milestones: [{ id: 'M-preview', title: 'Vorschau: Ergebnis prüfen', criteria: [
      { id: 'AC-preview-check', type: 'automated', description: 'Vorschau: Die Tests bestehen.', status: 'open', check: { command: 'npm test', expect: 'exit_code_0' } },
      { id: 'AC-preview-owner', type: 'manual', description: 'Vorschau: Ergebnis in der App ansehen und abnehmen.', status: 'open' }
    ] }], approved_by: 'Vorschau', frozen_at: at, amendments: [], links: { sessions: [], code_guardian_task: null }
  }
  const level = params.get('level')
  const state: CockpitSnapshot = {
    at, writable: !params.has('readonly'), error: null,
    settings: { level: level === 'board' || level === 'details' ? level : 'overview', retentionDays: 7 },
    pluginPath: 'C:/Vorschau/cockpit-plugin',
    adapters: [
      { source: 'registry', status: 'ok', detail: 'Vorschau: Session-Liste verbunden.' },
      { source: 'hook', status: 'missing', detail: 'Vorschau: Optionales Plugin noch nicht verbunden.' },
      { source: 'code_guardian', status: 'ok', detail: 'Vorschau: Projektdateien nur lesend verbunden.' }
    ],
    projects: params.has('cockpit-empty') ? [] : [{
      id: 1, root: 'C:/Vorschau/Projekt', name: 'Vorschau-Projekt', branch: 'main', state: 'waiting', observedSeconds: 3661,
      sessions: [{ id: 'preview-session', projectId: 1, pid: null, tileId: 'a1', name: 'Vorschau: Orchestrator',
        state: 'waiting', rawState: 'waiting', waitingFor: 'Vorschau: Freigabe benötigt', version: 'preview', supported: true,
        startedAt: at, updatedAt: at, observedSeconds: 3661, contractId: 'C-preview' }],
      waiting: [{ id: 'preview-waiting', projectId: 1, sessionId: 'preview-session', kind: 'plan_approval', source: 'registry',
        ref: 'preview', summary: 'Vorschau: Den überarbeiteten Plan durchsehen und freigeben.', openedAt: at, tileId: 'a1' }],
      tasks: [
        { id: 1, projectId: 1, title: 'Vorschau: Prüflauf auswerten', state: 'doing', source: 'manual', ref: null,
          contractId: 'C-preview', sessionId: null, createdAt: at, updatedAt: at },
        { id: 2, projectId: 1, title: 'Vorschau: Ergebnis in der App prüfen', state: 'done', source: 'code_guardian', ref: 'T-preview',
          contractId: null, sessionId: null, createdAt: at, updatedAt: at, rawState: 'vertagt',
          metadata: { Wirkung: 'V — Vorschau: Owner-Abnahme', Beleg: 'Vorschau: wartet auf reale App-Probe', Angelegt: 'Vorschau', Geschlossen: 'Vorschau: vertagt' } }
      ],
      contracts: [{ id: 'C-preview', path: 'C:/Vorschau/Projekt/.contracts/C-preview.json', document, errors: [], definitionHash: 'preview-hash',
        freeze: { hash: 'preview-hash', approvedBy: 'Vorschau', at }, changed: false, sourceFingerprint: 'preview-source',
        runs: [{ id: 1, projectId: 1, contractId: 'C-preview', criterionId: 'AC-preview-check', startedAt: at, finishedAt: at,
          command: 'npm test', exitCode: 0, signal: null, stdout: 'Vorschau: Testlauf bestanden.', stderr: '', error: null,
          gitHead: 'preview-only', freezeHash: 'preview-hash', sourceFingerprint: 'preview-source', passed: true }],
        manualApprovals: [], progress: { met: 1, total: 2 }, usage: { sessions: 1, observedSeconds: 3661, exceeded: false },
        fulfilled: false, running: false, goalText: '/goal Vorschau: Ziel anhand des Vertrags abschließen.' }],
      events: [{ id: 1, projectId: 1, sessionId: 'preview-session', at, source: 'runner', kind: 'criterion_finished',
        summary: 'Vorschau: Prüflauf erfolgreich beendet.', detail: '{"preview":true,"result":"passed"}' }]
    }]
  }
  return {
    load: () => structuredClone(state),
    command: async (command: CockpitCommand): Promise<CockpitResult> => {
      state.at = new Date().toISOString()
      if (command.type === 'refresh') return { ok: true }
      if (!state.writable) return { ok: false, error: 'Vorschau: Diese Instanz liest nur.' }
      if (command.type === 'save-settings') {
        state.settings = { level: command.level, retentionDays: command.retentionDays }
        return { ok: true }
      }
      const project = 'projectId' in command ? state.projects.find((item) => item.id === command.projectId) : null
      if (command.type === 'create-task' && project) {
        project.tasks.push({ id: Date.now(), projectId: project.id, title: command.title, state: 'todo', source: 'manual',
          ref: null, contractId: command.contractId ?? null, sessionId: null, createdAt: state.at, updatedAt: state.at })
        return { ok: true }
      }
      if (command.type === 'move-task' && project) {
        const task = project.tasks.find((item) => item.id === command.taskId)
        if (task?.source === 'manual') { task.state = command.state; return { ok: true } }
      }
      if (command.type === 'assign-task' && project) {
        const task = project.tasks.find((item) => item.id === command.taskId)
        if (task) { task.contractId = command.contractId; return { ok: true } }
      }
      if (command.type === 'assign-session' && project) {
        const session = project.sessions.find((item) => item.id === command.sessionId)
        if (session) { session.contractId = command.contractId; return { ok: true } }
      }
      return { ok: false, error: 'Vorschau: Diese Aktion wird nur in der Desktop-App ausgeführt.' }
    }
  }
}
