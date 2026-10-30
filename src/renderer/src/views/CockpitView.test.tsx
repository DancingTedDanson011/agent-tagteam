import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CockpitSnapshot, ContractDocument, ContractView, ProjectView } from '../../../shared/cockpit'
import { LangContext, en } from '../i18n'
import { CockpitView } from './CockpitView'

const document: ContractDocument = {
  contract_id: 'C-test', project: 'Test project', title: 'Verified outcome', status: 'frozen', objective: 'Prove the outcome.',
  non_goals: [], budget: { max_sessions: 2, max_hours: 1, stop_when_exceeded: true },
  milestones: [{ id: 'M-test', title: 'Outcome', criteria: [{ id: 'AC-test', type: 'manual', description: 'Inspect the real outcome.', status: 'met' }] }],
  approved_by: 'Owner', frozen_at: '2026-10-30T00:00:00Z', amendments: [], links: { sessions: [], code_guardian_task: null }
}
const contract: ContractView = {
  id: 'C-test', path: '/project/.contracts/C-test.json', document, errors: [], definitionHash: 'current',
  freeze: { hash: 'current', approvedBy: 'Owner', at: '2026-10-30T00:00:00Z' }, changed: false, sourceFingerprint: 'source-current',
  runs: [], manualApprovals: [], progress: { met: 0, total: 1 }, usage: { sessions: 0, observedSeconds: 0, exceeded: false },
  fulfilled: false, running: false, goalText: '/goal Inspect and verify.'
}
const project: ProjectView = {
  id: 1, root: '/project', name: 'Test project', branch: 'main', state: 'unknown', sessions: [], waiting: [],
  tasks: [], contracts: [contract], events: [], observedSeconds: 0
}
const snapshot = (partial: Partial<CockpitSnapshot> = {}): CockpitSnapshot => ({
  at: '2026-10-30T00:00:00Z', writable: true, error: null, projects: [project],
  adapters: [{ source: 'registry', status: 'unsupported', detail: 'Unverified source version.' }],
  settings: { level: 'details', retentionDays: 7 }, pluginPath: null, ...partial
})
const props = () => ({ lang: 'de' as const, onCommand: vi.fn(async () => ({ ok: true as const })),
  onOpenSession: vi.fn(), onPickFolder: vi.fn(async () => null), onCopy: vi.fn() })

describe('cockpit presentation', () => {
  it.each(['missing', 'ok'] as const)('keeps the available plugin path and copy control in Details with %s hooks', (status) => {
    const state = snapshot({ adapters: [{ source: 'hook', status, detail: 'Local observation plugin' }], pluginPath: '/app-data/cockpit-plugin' })
    const html = renderToStaticMarkup(<CockpitView snapshot={state} {...props()} />)
    const plugin = html.match(/<aside class="cockpit-plugin">[\s\S]*?<\/aside>/)?.[0]
    expect(plugin).toBeDefined()
    expect(plugin).toContain('<code>/app-data/cockpit-plugin</code>')
    expect(plugin).toContain('<button type="button" class="button is-quiet">Plugin-Pfad kopieren</button>')
  })
  it.each(['overview', 'board'] as const)('keeps healthy plugin setup out of the %s view', (level) => {
    const state = snapshot({ settings: { level, retentionDays: 7 }, adapters: [{ source: 'hook', status: 'ok', detail: 'Local observation plugin' }], pluginPath: '/app-data/cockpit-plugin' })
    const html = renderToStaticMarkup(<CockpitView snapshot={state} {...props()} />)
    expect(html).not.toContain('class="cockpit-plugin"')
    expect(html).not.toContain('/app-data/cockpit-plugin')
  })
  it('does not show a healthy plugin setup without an available path', () => {
    const state = snapshot({ adapters: [{ source: 'hook', status: 'ok', detail: 'Local observation plugin' }], pluginPath: null })
    const html = renderToStaticMarkup(<CockpitView snapshot={state} {...props()} />)
    expect(html).not.toContain('class="cockpit-plugin"')
  })
  it('shows an honest empty state without fabricated projects or sessions', () => {
    const html = renderToStaticMarkup(<CockpitView snapshot={snapshot({ projects: [] })} {...props()} />)
    expect(html).toContain('Deine Projekte an einem Ort')
    expect(html).toContain('Projekt hinzufügen')
    expect(html).not.toContain('Test project')
  })
  it('keeps load errors visible when no snapshot could be read', () => {
    const html = renderToStaticMarkup(<CockpitView snapshot={null} error="Disk unavailable" {...props()} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Disk unavailable')
  })
  it('shows a guardian decision without inventing an associated Claude session', () => {
    const state = snapshot({ projects: [{ ...project, waiting: [{ id: 'guardian-question', projectId: 1, sessionId: null,
      kind: 'cg_decision', source: 'code_guardian', ref: 'T-test', summary: 'Owner decision needed.', openedAt: '2026-10-30T00:00:00Z', tileId: null }] }] })
    const html = renderToStaticMarkup(<CockpitView snapshot={state} {...props()} />)
    expect(html).toContain('Owner decision needed.')
    expect(html).toContain('Code Guardian')
    expect(html).toContain('Nicht im Organizer')
    expect(html).toContain('T-test')
    expect(html).not.toContain('Zur Kachel</button>')
  })
  it('does not display a document-authored met criterion as verified without evidence', () => {
    const html = renderToStaticMarkup(<CockpitView snapshot={snapshot()} {...props()} />)
    expect(html).toContain('data-criterion-status="open"')
    expect(html).toContain('Noch kein gültiger Nachweis')
    expect(html).toContain('Geldkosten werden ohne angebundene Kostenquelle nicht berechnet.')
    expect(html).toContain('Nicht unterstützt')
  })
  it('disables mutations in a reader instance and exposes source tasks as observed status', () => {
    const state = snapshot({ writable: false, projects: [{ ...project, tasks: [{ id: 1, projectId: 1, title: 'Observed task', state: 'doing',
      source: 'hook', ref: 'task-ref', contractId: null, sessionId: null, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z' }] }] })
    const html = renderToStaticMarkup(<CockpitView snapshot={state} {...props()} />)
    expect(html).toContain('Nur lesen')
    expect(html).toContain('Status aus der Quelle')
    expect(html).toMatch(/disabled=""[^>]*>Aufgabe anlegen/)
  })
  it('keeps local detail navigation available in a read-only instance', () => {
    const state = snapshot({ writable: false, settings: { level: 'overview', retentionDays: 7 } })
    const html = renderToStaticMarkup(<CockpitView snapshot={state} {...props()} />)
    const detailButton = html.match(/<button[^>]*data-testid="cockpit-level-details"[^>]*>/)?.[0]
    expect(detailButton).toBeDefined()
    expect(detailButton).not.toContain('disabled')
  })
  it.each(['vertagt', 'fremd', 'verworfen'])('labels the original %s source state and its evidence instead of implying completed work', (rawState) => {
    const state = snapshot({ projects: [{ ...project, tasks: [{
      id: 1, projectId: 1, title: 'Imported source task', state: 'done', rawState, source: 'code_guardian',
      ref: 'T-source', contractId: null, sessionId: null, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z',
      metadata: { Wirkung: 'V — Owner request', Beleg: 'SOURCE-EVIDENCE', Angelegt: 'SOURCE-CREATED', Geschlossen: 'SOURCE-CLOSED' }
    }] }] })
    const html = renderToStaticMarkup(<CockpitView snapshot={state} {...props()} />)
    expect(html).toContain('Quellzustand')
    expect(html).toContain(rawState)
    expect(html).toContain('<dt>Beleg</dt>')
    expect(html).toContain('SOURCE-EVIDENCE')
    expect(html).toContain('SOURCE-CREATED')
    expect(html).toContain('SOURCE-CLOSED')
    expect(html).not.toContain('&quot;Wirkung&quot;:')
  })
  it('renders external summaries and raw detail as text, never executable markup', () => {
    const state = snapshot({ projects: [{ ...project, events: [{ id: 1, projectId: 1, sessionId: null, source: 'hook',
      kind: 'unknown', at: '2026-10-30T00:00:00Z', summary: '<script>external()</script>', detail: '<img src=x onerror=external()>' }] }] })
    const html = renderToStaticMarkup(<CockpitView snapshot={state} {...props()} />)
    expect(html).toContain('&lt;script&gt;external()&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
  })
  it('renders the same working cockpit in English', () => {
    const html = renderToStaticMarkup(<LangContext.Provider value={en}><CockpitView snapshot={snapshot()} {...props()} lang="en" /></LangContext.Provider>)
    expect(html).toContain('Project cockpit')
    expect(html).toContain('Waiting for you')
    expect(html).toContain('Approve criterion')
  })
})
