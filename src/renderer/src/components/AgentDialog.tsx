// INTENTIONAL-UNTESTED: dialog component without a unit harness (no DOM test dependency); exercised by
// the in-app selftest (starts an agent tile) and the Playwright preview probe. A failed start shows
// the main process's reason (program path + system message) when there is one.
import { useEffect, useState } from 'react'
import type { AgentProvider, AgentRole } from '../../../shared/types'
import { useT } from '../i18n'
import { Dialog } from './Dialog'

const ORDER: AgentProvider[] = ['claude', 'codex', 'opencode', 'cmd', 'pwsh']
const isAi = (p: AgentProvider) => p === 'claude' || p === 'codex' || p === 'opencode'

export function AgentDialog({ onClose, onStarted }: { onClose: () => void; onStarted: (id: string) => void }) {
  const t = useT()
  const [available, setAvailable] = useState<AgentProvider[] | null>(null)
  const [provider, setProvider] = useState<AgentProvider>('claude')
  const [role, setRole] = useState<AgentRole>('plain')
  const [cwd, setCwd] = useState<string | null>(null)
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.organizer.availableAgents().then((list) => {
      setAvailable(list)
      if (!list.includes('claude') && list[0]) setProvider(list[0])
    })
  }, [])

  const pick = async () => setCwd((await window.organizer.pickFolder()) ?? cwd)

  const start = async () => {
    if (!cwd) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.organizer.startAgent({ provider, role: isAi(provider) ? role : 'plain', cwd, task: isAi(provider) ? task : '' })
      if (r.ok) onStarted(r.id)
      else setError(t.agentStartFailed(r.detail ?? r.error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={t.agentStart} onClose={onClose}>
      <form
        className="agent-form"
        onSubmit={(e) => {
          e.preventDefault()
          void start()
        }}
      >
        <fieldset>
          <legend>{t.agentProgram}</legend>
          <div className="choice-list">
            {ORDER.map((p) => {
              const missing = available !== null && !available.includes(p)
              return (
                <label key={p} className={`choice${missing ? ' is-missing' : ''}`}>
                  <input type="radio" name="provider" value={p} checked={provider === p} disabled={missing} onChange={() => setProvider(p)} />
                  <span>{t.agentProvider[p]}</span>
                  {missing && <span className="choice-note">{t.agentNotInstalled}</span>}
                </label>
              )
            })}
          </div>
        </fieldset>

        {isAi(provider) && (
          <fieldset>
            <legend>{t.agentRole}</legend>
            <div className="choice-list is-row">
              <label className="choice">
                <input type="radio" name="role" checked={role === 'plain'} onChange={() => setRole('plain')} />
                <span>{t.agentRolePlain}</span>
              </label>
              <label className="choice">
                <input type="radio" name="role" checked={role === 'orchestrator'} onChange={() => setRole('orchestrator')} />
                <span>{t.agentRoleOrchestrator}</span>
              </label>
            </div>
            {/* INTENTIONAL-UNTESTED: text only; both roles now have the tools (providers.test.ts hasOrganizerTools) */}
            <p className="hint">{role === 'orchestrator' ? t.agentRoleOrchestratorHint : t.agentRolePlainHint}</p>
          </fieldset>
        )}

        <div className="field">
          <span className="field-label">{t.agentFolder}</span>
          <div className="folder-row">
            <span className={`folder-path${cwd ? '' : ' is-empty'}`} title={cwd ?? undefined}>
              {cwd ?? t.agentNoFolder}
            </span>
            <button type="button" className="button is-quiet" onClick={() => void pick()}>
              {t.agentPickFolder}
            </button>
          </div>
        </div>

        {isAi(provider) && (
          <label className="field">
            <span className="field-label">{t.agentTask}</span>
            <textarea value={task} maxLength={8000} rows={3} onChange={(e) => setTask(e.target.value)} />
          </label>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="submit" className="button is-primary" disabled={!cwd || busy}>
            {t.agentGo}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
