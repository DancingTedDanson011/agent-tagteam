// INTENTIONAL-UNTESTED: root component wiring without a unit harness (no DOM test dependency); state
// logic is unit-tested in model.ts/workspaces.ts, the wiring by the in-app selftest end to end.
import { useCallback, useEffect, useReducer, useState } from 'react'
import type { Lang, SlotLaunch, ViewMode, Workspace } from '../../shared/types'
import type { CockpitSnapshot } from '../../shared/cockpit'
import { Dock } from './components/Dock'
import { EmptyState } from './components/EmptyState'
import { Icon } from './components/Icon'
import { Picker } from './components/Picker'
import { AgentDialog } from './components/AgentDialog'
import { LaunchBar } from './components/LaunchBar'
import { StyleContext, StyleDialog } from './components/StyleDialog'
import { VoiceButton, VoiceSettingsDialog } from './components/VoiceButton'
import { useVoice } from './useVoice'
import { Titlebar } from './components/Titlebar'
import { DICTS, LangContext } from './i18n'
import { WorkspacesDialog } from './components/WorkspacesDialog'
import { useLayoutSync } from './layout-sync'
import { listenToAgents, syncListed } from './terminals'
import { initialState, mergeSubOrder, reduce, roles } from './model'
import { FocusView } from './views/FocusView'
import { FreeView } from './views/FreeView'
import { GridView } from './views/GridView'
import { TabsView } from './views/TabsView'
import { CockpitView } from './views/CockpitView'
import { assignSlots, missingSlots, workspaceFromState } from './workspaces'

const NOTICE_MS = 9000
const VIEW_KEYS: Record<string, ViewMode> = { '1': 'focus', '2': 'grid', '3': 'free', '4': 'tabs', '5': 'cockpit' }

export function App() {
  const [st, dispatch] = useReducer(reduce, undefined, initialState)
  const [lang, setLang] = useState<Lang>('de')
  const [styleId, setStyleId] = useState<string | null>(null)
  const [cockpit, setCockpit] = useState<CockpitSnapshot | null>(null)
  const [cockpitError, setCockpitError] = useState<string | null>(null)
  /** A workspace restore in progress or just finished (the notice slot shows it). */
  const [restore, setRestore] = useState<{ running: boolean; done: number; total: number; failed: number; home: number } | null>(null)
  const t = DICTS[lang]
  const r = roles(st)
  const voice = useVoice(st.focusId, st.order, st.modal !== null)
  useLayoutSync(st.order, r.attended, st.modal !== null)

  useEffect(() => {
    const api = window.organizer
    const offs = [
      api.onSessions((list) => dispatch({ type: 'sessions', list })),
      api.onDrag((state) => dispatch({ type: 'drag', state })),
      api.onCaptured((id) => dispatch({ type: 'captured', id })),
      api.onNotice((reason) => dispatch({ type: 'notice', reason }))
    ]
    offs.push(listenToAgents())
    api.ready()
    void api.loadLang().then(setLang)
    void api.loadWorkspaces().then((list) => dispatch({ type: 'workspaces', list }))
    return () => offs.forEach((off) => off())
  }, [])

  // Terminals of agent tiles that are gone are released.
  useEffect(() => syncListed(new Set(st.sessions.filter((s) => s.agent).map((s) => s.id))), [st.sessions])

  useEffect(() => {
    let active = true
    const accept = (snapshot: CockpitSnapshot) => {
      if (!active) return
      setCockpit((previous) => previous && previous.at > snapshot.at ? previous : snapshot)
      setCockpitError(null)
    }
    const off = window.organizer.onCockpit(accept)
    void window.organizer.loadCockpit().then(accept).catch((cause: unknown) => {
      if (active) setCockpitError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false; off() }
  }, [])

  useEffect(() => {
    if (!restore || restore.running) return
    const timer = setTimeout(() => setRestore(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [restore])

  useEffect(() => {
    if (!st.notice) return
    const timer = setTimeout(() => dispatch({ type: 'notice', reason: null }), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [st.notice])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && VIEW_KEYS[e.key]) {
        e.preventDefault()
        dispatch({ type: 'view', view: VIEW_KEYS[e.key] })
        window.organizer.reseat() // same as a click on the view (see its tooltip)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const byId = new Map(st.sessions.map((s) => [s.id, s]))
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((s) => s !== undefined)
  const visible = pick(st.order.filter((id) => !st.minimized.includes(id)))
  const docked = pick(st.order.filter((id) => st.minimized.includes(id)))

  const focus = useCallback((id: string) => {
    dispatch({ type: 'focus', id })
    window.organizer.clearBadge(id)
  }, [])
  const minimize = useCallback((id: string) => dispatch({ type: 'minimize', id }), [])
  const release = useCallback((id: string) => void window.organizer.release(id), [])
  const raise = useCallback(
    (id: string) => {
      dispatch({ type: 'reorder', order: [...st.order.filter((x) => x !== id), id] })
      window.organizer.focusSession(id)
    },
    [st.order]
  )

  const saveWorkspace = async (name: string, recipes: Record<string, SlotLaunch | null>, resume: boolean) => {
    const existing = st.workspaces.find((w) => w.name === name)
    const ws = workspaceFromState(st, name, existing?.id ?? crypto.randomUUID(), recipes, resume)
    const list = [...st.workspaces.filter((w) => w.id !== ws.id), ws]
    const ok = await window.organizer.saveWorkspaces(list)
    if (ok) {
      dispatch({ type: 'workspaces', list })
      dispatch({ type: 'applyWorkspace', workspace: ws })
    }
    return ok
  }
  const deleteWorkspace = async (id: string) => {
    const list = st.workspaces.filter((w) => w.id !== id)
    const ok = await window.organizer.saveWorkspaces(list)
    if (ok) dispatch({ type: 'workspaces', list })
    return ok
  }
  const applyWorkspace = async (w: Workspace) => {
    const present = st.order.map((id) => byId.get(id)).filter((s) => s !== undefined)
    const missing = missingSlots(w, present)
    dispatch({ type: 'applyWorkspace', workspace: w })
    dispatch({ type: 'modal', modal: null })
    // Open sessions that found their slot take its name and colour, unless the user gave them their own.
    for (const [id, i] of assignSlots(w, present)) {
      const s = byId.get(id)
      const slot = w.slots[i]
      if (s && !s.label && !s.color && (slot.label || slot.color)) window.organizer.setSessionStyle(id, { label: slot.label ?? '', ...(slot.color ? { color: slot.color } : {}) })
    }
    if (missing.length === 0) return
    const progress = { running: true, done: 0, total: missing.length, failed: 0, home: 0 }
    setRestore({ ...progress })
    for (const i of missing) {
      const r = await window.organizer.restoreSlot(w.slots[i], w.resume === true)
      if (r.ok) {
        progress.done++
        if (r.homeFallback) progress.home++
        dispatch({ type: 'slotCaptured', id: r.id, slot: i, workspaceId: w.id })
      } else progress.failed++
      setRestore({ ...progress })
    }
    setRestore({ ...progress, running: false })
  }

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  const chooseLang = (next: Lang) => {
    setLang(next)
    void window.organizer.saveLang(next)
  }

  const openPicker = () => dispatch({ type: 'modal', modal: 'picker' })
  // The session of an open name-and-colour dialog went away: close the dialog (the modal would park every window).
  useEffect(() => {
    if (st.modal === 'style' && !(styleId && st.sessions.some((s) => s.id === styleId))) {
      setStyleId(null)
      dispatch({ type: 'modal', modal: null })
    }
  }, [st.modal, st.sessions, styleId])
  const openStyle = useCallback((id: string) => {
    setStyleId(id)
    dispatch({ type: 'modal', modal: 'style' })
  }, [])
  const big = st.focusId ? (byId.get(st.focusId) ?? null) : null
  const activeWorkspace = st.workspaces.find((w) => w.id === st.workspaceId) ?? null

  return (
    <LangContext.Provider value={t}>
    <StyleContext.Provider value={openStyle}>
    <div className={`app${st.drag.active ? ' is-drop-target' : ''}${st.drag.over ? ' is-drop-over' : ''}`}>
      <Titlebar
        view={st.view}
        drag={st.drag}
        workspace={activeWorkspace}
        lang={lang}
        onLang={chooseLang}
        hasSessions={st.order.length > 0 || st.workspaces.length > 0}
        onView={(view) => dispatch({ type: 'view', view })}
        onPicker={openPicker}
        onWorkspaces={() => dispatch({ type: 'modal', modal: 'workspaces' })}
        onAgent={() => dispatch({ type: 'modal', modal: 'agent' })}
      />

      <div className="notice-slot" aria-live="polite">
        {restore && (
          <div className="notice" role="status">
            <span>
              {restore.running
                ? t.restoreRunning(restore.done + restore.failed, restore.total)
                : [restore.done > 0 && t.restoreDone(restore.done), restore.home > 0 && t.restoreHome(restore.home), restore.failed > 0 && t.restoreFailed(restore.failed)]
                    .filter(Boolean)
                    .join(' ')}
            </span>
            {!restore.running && (
              <button type="button" className="icon-button" onClick={() => setRestore(null)}>
                <Icon name="close" />
                <span className="sr-only">{t.closeNotice}</span>
              </button>
            )}
          </div>
        )}
        {st.notice && (
          <div className="notice" role="status">
            <span>{t.refusal[st.notice]}</span>
            <button type="button" className="icon-button" onClick={() => dispatch({ type: 'notice', reason: null })}>
              <Icon name="close" />
              <span className="sr-only">{t.closeNotice}</span>
            </button>
          </div>
        )}
      </div>

      <main className="stage">
        {st.view === 'cockpit' ? (
          <CockpitView snapshot={cockpit} error={cockpitError} lang={lang}
            onCommand={async (command) => {
              const result = await window.organizer.cockpitCommand(command)
              if (result.ok) {
                try { setCockpit(await window.organizer.loadCockpit()); setCockpitError(null) }
                catch (cause) { setCockpitError(cause instanceof Error ? cause.message : String(cause)) }
              }
              return result
            }}
            onOpenSession={(id) => {
              if (!st.order.includes(id)) { setCockpitError(t.cockpit.notInOrganizer); return }
              dispatch({ type: 'view', view: 'focus' })
              focus(id)
            }}
            onPickFolder={() => window.organizer.pickFolder()}
            onCopy={(text) => window.organizer.clipboardWrite(text)} />
        ) : st.order.length === 0 ? (
          <EmptyState onPicker={openPicker} />
        ) : st.view === 'focus' ? (
          <FocusView
            big={big && visible.includes(big) ? big : null}
            others={visible}
            onFocus={focus}
            onMinimize={minimize}
            onRelease={release}
            onReorder={(ids) => dispatch({ type: 'reorder', order: mergeSubOrder(st.order, ids) })}
          />
        ) : st.view === 'grid' ? (
          <GridView sessions={visible} onMinimize={minimize} onRelease={release} />
        ) : st.view === 'free' ? (
          <FreeView
            sessions={visible}
            free={st.free}
            onMove={(id, rect) => dispatch({ type: 'moveFree', id, rect })}
            onRaise={raise}
            onBringToFront={(id) => {
              if (st.order[st.order.length - 1] !== id) dispatch({ type: 'reorder', order: [...st.order.filter((x) => x !== id), id] })
            }}
            onMinimize={minimize}
            onRelease={release}
          />
        ) : (
          <TabsView sessions={visible} activeId={st.focusId} onSelect={focus} onMinimize={minimize} onRelease={release} />
        )}
      </main>

      <div className="bottom-bar">
        <div className="launch-row">
          <LaunchBar onStarted={(id) => dispatch({ type: 'captured', id })} />
          <VoiceButton voice={voice} onSettings={() => dispatch({ type: 'modal', modal: 'voice' })} />
        </div>
        <Dock sessions={docked} onRestore={focus} />
      </div>

      {st.modal === 'picker' && (
        <Picker
          onClose={() => dispatch({ type: 'modal', modal: null })}
          onCaptured={(id) => dispatch({ type: 'captured', id })} // the dialog stays open for the next one
        />
      )}
      {st.modal === 'agent' && (
        <AgentDialog
          onClose={() => dispatch({ type: 'modal', modal: null })}
          onStarted={(id) => {
            dispatch({ type: 'captured', id })
            dispatch({ type: 'modal', modal: null })
          }}
        />
      )}
      {st.modal === 'workspaces' && (
        <WorkspacesDialog
          workspaces={st.workspaces}
          activeId={st.workspaceId}
          sessions={pick(st.order)}
          restoring={!!restore?.running}
          onClose={() => dispatch({ type: 'modal', modal: null })}
          onApply={(w) => void applyWorkspace(w)}
          onSave={saveWorkspace}
          onDelete={deleteWorkspace}
        />
      )}
      {st.modal === 'voice' && (
        <VoiceSettingsDialog settings={voice.settings} onSave={voice.setSettings} onClose={() => dispatch({ type: 'modal', modal: null })} />
      )}
      {st.modal === 'style' && styleId && byId.get(styleId) && (
        <StyleDialog
          session={byId.get(styleId)!}
          onClose={() => {
            setStyleId(null)
            dispatch({ type: 'modal', modal: null })
          }}
        />
      )}
    </div>
    </StyleContext.Provider>
    </LangContext.Provider>
  )
}
