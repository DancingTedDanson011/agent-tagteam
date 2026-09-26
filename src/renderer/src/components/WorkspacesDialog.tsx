// INTENTIONAL-UNTESTED: presentational dialog without a unit harness (no DOM test dependency); the
// recipe rules are unit-tested (shared/restore.ts, workspaces.ts), the dialog by the in-app selftest.
import { useEffect, useState } from 'react'
import { normalizeFolder } from '../../../shared/folder'
import type { SessionInfo, SlotLaunch, Workspace, WindowRun } from '../../../shared/types'
import { useT } from '../i18n'
import { Dialog } from './Dialog'
import { ColorMark, displayTitle } from './SessionHeader'

type Props = {
  workspaces: Workspace[]
  activeId: string | null
  /** The sessions a save would record, in slot order. */
  sessions: SessionInfo[]
  /** A workspace is still opening its windows: applying another waits until it is done. INTENTIONAL-UNTESTED: prop plumbing. */
  restoring: boolean
  onClose: () => void
  onApply: (w: Workspace) => void
  onSave: (name: string, recipes: Record<string, SlotLaunch | null>, resume: boolean) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
}

type WindowLaunch = Extract<SlotLaunch, { kind: 'window' }>
const RUNS: WindowRun[] = ['claude', 'codex', 'opencode']

/** The folder this slot had in a saved workspace (same name, else same program and title). */
function savedFolder(workspaces: Workspace[], s: SessionInfo): string {
  for (const w of workspaces)
    for (const slot of w.slots) {
      const cwd = slot.launch?.kind === 'window' ? slot.launch.cwd : null
      if (cwd && ((s.label && slot.label === s.label) || (!s.label && slot.rule.processName === s.processName && slot.rule.titleIncludes && s.title.includes(slot.rule.titleIncludes)))) return cwd
    }
  return ''
}

// INTENTIONAL-UNTESTED: signature change only (restoring added); covered by the selftest.
export function WorkspacesDialog({ workspaces, activeId, sessions, restoring, onClose, onApply, onSave, onDelete }: Props) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [recipes, setRecipes] = useState<Record<string, SlotLaunch | null>>({})
  const [folders, setFolders] = useState<Record<string, string>>({})
  const [home, setHome] = useState('')
  const [resume, setResume] = useState(() => workspaces.find((w) => w.id === activeId)?.resume ?? false)
  const t = useT()
  const canSave = sessions.length > 0
  const ids = sessions.map((s) => s.id).join(',')

  useEffect(() => {
    let live = true
    void window.organizer.describeSessions(ids ? ids.split(',') : []).then(({ home: h, recipes: r }) => {
      if (!live) return
      setHome(h)
      setRecipes(r)
      const initial: Record<string, string> = {}
      for (const s of sessions) {
        const l = r[s.id]
        if (l?.kind === 'window' && l.cwd === null) initial[s.id] = savedFolder(workspaces, s)
      }
      setFolders(initial)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per set of sessions
  }, [ids])

  const setRun = (id: string, run: WindowRun | '') =>
    setRecipes((r) => {
      const l = r[id] as WindowLaunch
      const { run: _old, ...rest } = l
      return { ...r, [id]: (run ? { ...rest, run } : rest) as SlotLaunch }
    })

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) return setError(t.wsNameMissing)
    if (trimmed.length > 60) return setError(t.wsNameTooLong)
    const final: Record<string, SlotLaunch | null> = { ...recipes }
    for (const s of sessions) {
      const l = final[s.id]
      if (l?.kind !== 'window' || !(s.id in folders)) continue
      const raw = folders[s.id].trim()
      const cwd = raw ? normalizeFolder(raw, home) : null
      // INTENTIONAL-UNTESTED: dialog glue; the ";" refusal itself is pinned in restore.test.ts (parseSlotLaunch).
      // Windows Terminal reads ";" as a command separator: such a folder would be dropped on save.
      if ((raw && !cwd) || (l.host === 'wt' && cwd?.includes(';'))) return setError(t.wsBadFolder(displayTitle(s)))
      final[s.id] = { ...l, cwd }
    }
    setError(null)
    if (await onSave(trimmed, final, resume)) setName('')
    else setError(t.wsSaveFailed)
  }

  return (
    <Dialog title={t.workspaces} onClose={onClose}>
      <p className="hint">{t.wsHint}</p>

      <form
        className="save-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label htmlFor="ws-name">{t.wsSaveAs}</label>
        <div className="save-row">
          <input
            id="ws-name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            aria-describedby={error ? 'ws-error' : undefined}
            aria-invalid={error ? true : undefined}
            disabled={!canSave}
          />
          <button type="submit" className="button is-primary" disabled={!canSave}>
            {t.wsSave}
          </button>
        </div>
        {!canSave && <p className="hint">{t.wsNeedTerminal}</p>}
        {error && (
          <p id="ws-error" className="error" role="alert">
            {error}
          </p>
        )}

        {canSave && (
          <fieldset className="ws-windows">
            <legend>{t.wsWindows}</legend>
            <ul className="ws-window-list">
              {sessions.map((s) => {
                const l = recipes[s.id]
                const title = displayTitle(s)
                const kind = !l ? 'none' : l.kind === 'agent' ? 'agent' : l.host
                return (
                  <li key={s.id} className="ws-window">
                    <div className="ws-window-head">
                      <ColorMark session={s} />
                      <span className="ws-window-title">{title}</span>
                      <span className="candidate-meta">{t.wsRecipe[kind]}</span>
                    </div>
                    {l?.kind === 'window' && s.id in folders && (
                      <div className="ws-window-fields">
                        <input
                          value={folders[s.id]}
                          onChange={(e) => setFolders((f) => ({ ...f, [s.id]: e.target.value }))}
                          placeholder={t.wsFolderPlaceholder}
                          aria-label={t.wsFolderFor(title)}
                          title={t.wsFolderWhy}
                          spellCheck={false}
                        />
                      </div>
                    )}
                    {l?.kind === 'window' && (
                      <div className="ws-window-fields">
                        <select value={l.run ?? ''} onChange={(e) => setRun(s.id, e.target.value as WindowRun | '')} aria-label={t.wsProgramFor(title)}>
                          <option value="">{t.wsProgramNone}</option>
                          {RUNS.map((r) => (
                            <option key={r} value={r}>
                              {t.agentProvider[r]}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            <label className="check-row">
              <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
              <span>{t.wsResume}</span>
            </label>
          </fieldset>
        )}
      </form>

      {workspaces.length > 0 && (
        <ul className="workspace-list">
          {workspaces.map((w) => (
            <li key={w.id} className={`workspace${w.id === activeId ? ' is-active' : ''}`}>
              <div className="candidate-text">
                <span className="candidate-title">{w.name}</span>
                <span className="candidate-meta">
                  {t.view[w.view]} · {t.wsSlots(w.slots.length)}
                </span>
              </div>
              <button type="button" className="button is-quiet" onClick={() => void onDelete(w.id)}>
                {t.wsDelete}
              </button>
              {/* INTENTIONAL-UNTESTED: apply path pinned by the selftest (workspace restore section) */}
              <button type="button" className="button is-primary" onClick={() => onApply(w)} disabled={restoring} title={restoring ? t.wsBusy : undefined}>
                {t.wsApply}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
