import { useState, type FormEvent } from 'react'
import type {
  CockpitCommand, CockpitLevel, CockpitResult, CockpitSnapshot, CockpitState,
  ContractCriterion, ContractView, ProjectView, TaskState
} from '../../../shared/cockpit'
import type { Lang } from '../../../shared/types'
import { Dialog } from '../components/Dialog'
import { Icon } from '../components/Icon'
import { useT } from '../i18n'
import { criterionState, currentRun, elapsedTime, milestoneProgress } from './cockpit-model'
import './cockpit.css'

type Props = {
  snapshot: CockpitSnapshot | null
  error?: string | null
  lang: Lang
  onCommand: (command: CockpitCommand) => Promise<CockpitResult>
  onOpenSession: (tileId: string) => void
  onPickFolder: () => Promise<string | null>
  onCopy: (text: string) => void
}
type Review = { projectId: number; contractId: string; definitionHash: string | null; freezeHash: string | null; sourceFingerprint: string | null }
type Editor =
  | { type: 'new'; projectId: number }
  | ({ type: 'edit' | 'freeze' | 'amend' } & Review)
  | ({ type: 'approve'; criterionId: string } & Review)
const LEVELS: CockpitLevel[] = ['overview', 'board', 'details']
const TASK_STATES: TaskState[] = ['todo', 'doing', 'review', 'done', 'blocked']
type Perform = (command: CockpitCommand) => Promise<boolean>

function review(contract: ContractView) {
  return { contractId: contract.id, definitionHash: contract.definitionHash, freezeHash: contract.freeze?.hash ?? null, sourceFingerprint: contract.sourceFingerprint }
}

function timestamp(value: string, lang: Lang): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(lang === 'de' ? 'de-CH' : 'en-GB') : value
}

function Status({ state }: { state: CockpitState }) {
  const t = useT().cockpit
  return <span className={'cockpit-status is-' + state}><i aria-hidden="true" />{t.states[state]}</span>
}

function Progress({ met, total, title }: { met: number; total: number; title: string }) {
  const t = useT().cockpit
  return (
    <div className="cockpit-progress">
      <progress max={Math.max(1, total)} value={met} aria-label={title + ': ' + met + ' / ' + total} />
      <span>{total ? met + ' / ' + total + ' ' + t.met : t.noCriteria}</span>
    </div>
  )
}

function ContractOptions({ project, selected }: { project: ProjectView; selected: string | null }) {
  const t = useT().cockpit
  return <>
    <option value="">{t.noContract}</option>
    {selected && !project.contracts.some((contract) => contract.id === selected) && <option value={selected}>{selected}</option>}
    {project.contracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.document?.title ?? contract.id}</option>)}
  </>
}

function TaskBoard({ project, level, locked, perform }: { project: ProjectView; level: CockpitLevel; locked: boolean; perform: Perform }) {
  const t = useT().cockpit
  const metadataLabels: Record<string, string> = t.taskMetadataLabels
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const title = String(data.get('title') ?? '').trim()
    if (!title) return
    if (await perform({ type: 'create-task', projectId: project.id, title, contractId: String(data.get('contract') ?? '') || null })) form.reset()
  }
  return (
    <section className="cockpit-section" aria-labelledby="cockpit-board-title">
      <h3 id="cockpit-board-title">{t.levels.board}</h3>
      <form className="cockpit-task-form" data-testid="cockpit-create-task" onSubmit={(event) => void submit(event)}>
        <div className="cockpit-field"><label htmlFor="cockpit-task-title">{t.taskTitle}</label>
          <input id="cockpit-task-title" data-testid="cockpit-task-title" name="title" required maxLength={500} placeholder={t.taskPlaceholder} disabled={locked} /></div>
        <div className="cockpit-field"><label htmlFor="cockpit-task-contract">{t.contractAssignment}</label>
          <select id="cockpit-task-contract" name="contract" disabled={locked}><ContractOptions project={project} selected={null} /></select></div>
        <button type="submit" className="button is-primary" data-testid="cockpit-add-task" disabled={locked}>{t.addTask}</button>
      </form>
      <div className="cockpit-board">
        {TASK_STATES.map((state) => {
          const tasks = project.tasks.filter((task) => task.state === state)
          return <section className="cockpit-column" key={state} aria-label={t.taskStates[state]}>
            <h4>{t.taskStates[state]} <span>{tasks.length}</span></h4>
            {tasks.length === 0 && <p className="cockpit-muted">{t.noTasks}</p>}
            {tasks.map((task) => <article className="cockpit-task" key={task.id} data-testid={'cockpit-task-' + task.id}>
              <p className="cockpit-task-title">{task.title}</p>
              <p className="cockpit-muted">{t.sources[task.source]}</p>
              {task.rawState && <p className="cockpit-source-state"><span>{t.sourceState}: </span><strong>{task.rawState}</strong></p>}
              <label className="sr-only" htmlFor={'cockpit-task-state-' + task.id}>{t.taskState + ': ' + task.title}</label>
              <select id={'cockpit-task-state-' + task.id} data-testid={'cockpit-task-state-' + task.id} value={task.state} disabled={locked || task.source !== 'manual'}
                onChange={(event) => void perform({ type: 'move-task', projectId: project.id, taskId: task.id, state: event.target.value as TaskState })}>
                {TASK_STATES.map((value) => <option value={value} key={value}>{t.taskStates[value]}</option>)}
              </select>
              {task.source !== 'manual' && <span className="cockpit-muted">{t.fromSource}</span>}
              <label className="sr-only" htmlFor={'cockpit-task-contract-' + task.id}>{t.contractAssignment + ': ' + task.title}</label>
              <select id={'cockpit-task-contract-' + task.id} value={task.contractId ?? ''} disabled={locked}
                onChange={(event) => void perform({ type: 'assign-task', projectId: project.id, taskId: task.id, contractId: event.target.value || null })}>
                <ContractOptions project={project} selected={task.contractId} />
              </select>
              {!task.contractId && <span className="cockpit-outside">{t.outsideContract}</span>}
              {level === 'details' && task.metadata && Object.keys(task.metadata).length > 0 && <dl className="cockpit-task-metadata">
                {Object.entries(task.metadata).map(([key, value]) => <div key={key}><dt>{metadataLabels[key] ?? key}</dt><dd>{value}</dd></div>)}
              </dl>}
              {task.ref && <details><summary>{t.sourceReference}</summary><code>{task.ref}</code></details>}
            </article>)}
          </section>
        })}
      </div>
    </section>
  )
}

function Criterion({ contract, criterion, project, locked, lang, perform, edit }: {
  contract: ContractView; criterion: ContractCriterion; project: ProjectView; locked: boolean; lang: Lang; perform: Perform; edit: (editor: Editor) => void
}) {
  const t = useT().cockpit
  const state = criterionState(contract, criterion)
  const run = currentRun(contract, criterion.id)
  const approval = contract.manualApprovals.find((item) => item.criterionId === criterion.id && item.freezeHash === contract.freeze?.hash &&
    !!contract.sourceFingerprint && item.sourceFingerprint === contract.sourceFingerprint)
  const canCheck = !locked && !!contract.freeze && !contract.changed && !contract.running && contract.errors.length === 0 && contract.document?.status !== 'cancelled'
  return (
    <li className="cockpit-criterion" data-criterion-status={state}>
      <div className="cockpit-row">
        <strong>{criterion.id}</strong>
        <span className={'cockpit-criterion-state is-' + state}>{t.criterionStates[state]}</span>
        <span className="cockpit-muted">{criterion.type === 'manual' ? t.manual : t.automated}</span>
      </div>
      <p>{criterion.description}</p>
      {criterion.check && <pre className="cockpit-command">{criterion.check.command}</pre>}
      <div className="cockpit-actions">
        {criterion.type === 'manual'
          ? <button type="button" className="button is-quiet" disabled={!canCheck || !contract.sourceFingerprint}
              title={!contract.sourceFingerprint ? t.missingReview : undefined}
              onClick={() => edit({ type: 'approve', projectId: project.id, ...review(contract), criterionId: criterion.id })}>{t.approve}</button>
          : <button type="button" className="button is-quiet" disabled={!canCheck}
              onClick={() => void perform({ type: 'run-criterion', projectId: project.id, contractId: contract.id, criterionId: criterion.id })}>{t.checkOne}</button>}
      </div>
      {run ? <details className="cockpit-evidence">
        <summary>{t.evidence} · {timestamp(run.startedAt, lang)}</summary>
        <dl className="cockpit-facts">
          <div><dt>{t.command}</dt><dd><code>{run.command}</code></dd></div>
          <div><dt>{t.exitCode}</dt><dd>{run.exitCode ?? t.checking}</dd></div>
          <div><dt>{t.gitHead}</dt><dd><code>{run.gitHead ?? t.noGitHead}</code></dd></div>
        </dl>
        {run.signal && <p className="cockpit-warning">{run.signal}</p>}
        {run.error && <p className="cockpit-warning">{run.error}</p>}
        <h5>{t.output}</h5><pre>{run.stdout || t.noOutput}</pre>
        {run.stderr && <><h5>{t.stderr}</h5><pre>{run.stderr}</pre></>}
      </details> : approval && state === 'met'
        ? <p className="cockpit-muted">{t.manual}: {approval.approvedBy} · {timestamp(approval.at, lang)}</p>
        : <p className="cockpit-muted">{t.noEvidence}</p>}
    </li>
  )
}

function Contracts({ project, level, locked, lang, perform, edit, copy }: {
  project: ProjectView; level: CockpitLevel; locked: boolean; lang: Lang; perform: Perform; edit: (editor: Editor) => void; copy: (text: string) => void
}) {
  const t = useT().cockpit
  return <section className="cockpit-section" aria-labelledby="cockpit-contracts-title">
    <div className="cockpit-section-heading"><h3 id="cockpit-contracts-title">{t.contracts}</h3>
      {level !== 'overview' && <button type="button" className="button is-quiet" data-testid="cockpit-create-contract" disabled={locked} onClick={() => edit({ type: 'new', projectId: project.id })}>{t.newContract}</button>}</div>
    {project.contracts.length === 0 && <div className="cockpit-empty-inline"><p>{t.noContracts}</p><p className="cockpit-muted">{t.contractHint}</p></div>}
    {project.contracts.map((contract) => {
      const document = contract.document
      const canRun = !!contract.freeze && !contract.changed && !contract.running && contract.errors.length === 0 && document?.status !== 'cancelled'
      const editable = !contract.freeze || document?.status === 'draft' || document?.status === 'amended'
      return <article className="cockpit-contract" key={contract.id} data-testid={'cockpit-contract-' + contract.id}>
        <div className="cockpit-section-heading"><div><span className="cockpit-muted">{contract.id}</span>
          <h4>{document?.title ?? contract.id}</h4></div>
          <span className={contract.fulfilled ? 'cockpit-verified' : 'cockpit-muted'}>{contract.fulfilled ? t.fulfilled : document ? t.contractStates[document.status] : t.invalidContract}</span>
        </div>
        {document && <p>{document.objective}</p>}
        <Progress {...contract.progress} title={document?.title ?? contract.id} />
        {contract.changed && <p className="cockpit-warning" role="status">{t.changed}</p>}
        {contract.errors.length > 0 && <ul className="cockpit-warning">{contract.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
        {level !== 'overview' && <>
          {!contract.freeze && <p className="cockpit-muted">{t.draftHint}</p>}
          <div className="cockpit-actions">
            <button type="button" className="button is-primary" disabled={locked || !canRun}
              onClick={() => void perform({ type: 'run-contract', projectId: project.id, contractId: contract.id })}>{contract.running ? t.running : t.checkAll}</button>
            {contract.running && <button type="button" className="button is-quiet" disabled={locked}
              onClick={() => void perform({ type: 'cancel-check', projectId: project.id, contractId: contract.id })}>{t.cancelCheck}</button>}
            {(!contract.freeze || contract.changed || editable) && <button type="button" className="button is-quiet" disabled={locked || !document || !contract.definitionHash || contract.errors.length > 0 || contract.running}
              onClick={() => edit({ type: 'freeze', projectId: project.id, ...review(contract) })}>{t.freeze}</button>}
            {editable
              ? <button type="button" className="button is-quiet" disabled={locked || !contract.definitionHash || contract.running} onClick={() => edit({ type: 'edit', projectId: project.id, ...review(contract) })}>{t.edit}</button>
              : <button type="button" className="button is-quiet" disabled={locked || !contract.definitionHash || contract.running} onClick={() => edit({ type: 'amend', projectId: project.id, ...review(contract) })}>{t.amend}</button>}
            <button type="button" className="button is-quiet" disabled={!contract.goalText} onClick={() => contract.goalText && copy(contract.goalText)}>{t.goalCopy}</button>
          </div>
          {document?.milestones.map((milestone) => <section className="cockpit-milestone" key={milestone.id}>
            <h5>{milestone.id + ' · ' + milestone.title}</h5>
            <Progress {...milestoneProgress(contract, milestone)} title={milestone.title} />
            {level === 'details' && <ul className="cockpit-criteria">
              {milestone.criteria.map((criterion) => <Criterion key={criterion.id} contract={contract} criterion={criterion}
                project={project} locked={locked} lang={lang} perform={perform} edit={edit} />)}
            </ul>}
          </section>)}
        </>}
        {level === 'details' && <>
          <dl className="cockpit-facts cockpit-budget">
            <div><dt>{t.budget + ' · ' + t.sessions}</dt><dd>{contract.usage.sessions} / {document?.budget.max_sessions ?? '—'}</dd></div>
            <div><dt>{t.observedTime}</dt><dd>{elapsedTime(contract.usage.observedSeconds)} / {document ? document.budget.max_hours + ' h' : '—'}</dd></div>
            <div><dt>{t.file}</dt><dd><code>{contract.path}</code></dd></div>
          </dl>
          {contract.usage.exceeded && <p className="cockpit-warning">{t.exceeded}</p>}
          {document?.budget.stop_when_exceeded && <p className="cockpit-muted">{t.budgetStop}</p>}
          {contract.freeze && <p className="cockpit-muted">{t.approvedBy}: {contract.freeze.approvedBy} · {t.frozenAt}: {timestamp(contract.freeze.at, lang)}</p>}
          <p className="cockpit-muted">{t.noCosts}</p>
        </>}
      </article>
    })}
  </section>
}

function ContractEditor({ editor, project, locked, actionError, perform, close }: {
  editor: Editor; project: ProjectView; locked: boolean; actionError: string | null; perform: Perform; close: () => void
}) {
  const t = useT().cockpit
  const [error, setError] = useState<string | null>(null)
  const contract = editor.type === 'new' ? null : project.contracts.find((item) => item.id === editor.contractId) ?? null
  const criterion = editor.type === 'approve' ? contract?.document?.milestones.flatMap((item) => item.criteria).find((item) => item.id === editor.criterionId) : null
  const stale = editor.type !== 'new' && (!contract || contract.definitionHash !== editor.definitionHash ||
    (editor.type === 'approve' && ((contract.freeze?.hash ?? null) !== editor.freezeHash || contract.sourceFingerprint !== editor.sourceFingerprint)))
  const unavailable = editor.type !== 'new' && (!editor.definitionHash ||
    (editor.type === 'approve' && (!editor.freezeHash || !editor.sourceFingerprint)))
  const blocked = locked || stale || unavailable
  const issue = error ?? actionError ?? (stale ? t.reviewChanged : unavailable ? t.missingReview : null)
  const titles = { new: t.newContract, edit: t.edit, freeze: t.freeze, amend: t.amend, approve: t.approve }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    if (blocked) { setError(stale ? t.reviewChanged : unavailable ? t.missingReview : t.readonly); return }
    const data = new FormData(event.currentTarget)
    const text = (key: string) => String(data.get(key) ?? '').trim()
    let command: CockpitCommand
    switch (editor.type) {
      case 'new': {
        const maxSessions = Number(text('sessions'))
        const maxHours = Number(text('hours'))
        if (!text('title') || !text('objective') || !text('command') || !Number.isInteger(maxSessions) || maxSessions <= 0 || !Number.isFinite(maxHours) || maxHours <= 0) {
          setError(t.required)
          return
        }
        command = { type: 'create-contract', projectId: project.id, title: text('title'), objective: text('objective'), command: text('command'), maxSessions, maxHours }
        break
      }
      case 'edit':
        try { JSON.parse(text('json')) } catch { setError(t.invalidJson); return }
        command = { type: 'save-contract', projectId: project.id, contractId: editor.contractId, json: text('json'), expectedDefinitionHash: editor.definitionHash! }
        break
      case 'freeze':
        if (!text('owner')) { setError(t.required); return }
        command = { type: 'freeze-contract', projectId: project.id, contractId: editor.contractId, approvedBy: text('owner'), expectedDefinitionHash: editor.definitionHash! }
        break
      case 'approve':
        if (!text('owner')) { setError(t.required); return }
        command = { type: 'approve-criterion', projectId: project.id, contractId: editor.contractId, criterionId: editor.criterionId, approvedBy: text('owner'),
          expectedFreezeHash: editor.freezeHash!, expectedSourceFingerprint: editor.sourceFingerprint! }
        break
      case 'amend':
        if (!text('summary')) { setError(t.required); return }
        command = { type: 'amend-contract', projectId: project.id, contractId: editor.contractId, summary: text('summary'), expectedDefinitionHash: editor.definitionHash! }
    }
    if (await perform(command)) close()
  }
  return <Dialog title={titles[editor.type]} onClose={close}>
    <form className="cockpit-editor" data-testid="cockpit-contract-editor" onSubmit={(event) => void submit(event)}>
      <p className="cockpit-path">{project.root}</p>
      {editor.type === 'new' && <>
        <label htmlFor="cockpit-contract-title">{t.titleLabel}</label><input id="cockpit-contract-title" data-testid="cockpit-contract-title" name="title" maxLength={200} required autoFocus disabled={locked} />
        <label htmlFor="cockpit-objective">{t.objective}</label><textarea id="cockpit-objective" data-testid="cockpit-contract-objective" name="objective" maxLength={8000} required rows={3} disabled={locked} />
        <div className="cockpit-editor-budget">
          <div className="cockpit-field"><label htmlFor="cockpit-sessions-budget">{t.maxSessions}</label><input id="cockpit-sessions-budget" data-testid="cockpit-contract-sessions" name="sessions" type="number" min="1" max="100000" step="1" required disabled={locked} /></div>
          <div className="cockpit-field"><label htmlFor="cockpit-hours-budget">{t.maxHours}</label><input id="cockpit-hours-budget" data-testid="cockpit-contract-hours" name="hours" type="number" min="0" max="100000" step="any" required disabled={locked} /></div>
        </div>
        <label htmlFor="cockpit-check-command">{t.command}</label><textarea id="cockpit-check-command" data-testid="cockpit-contract-command" name="command" maxLength={8000} required rows={3} spellCheck={false} disabled={locked} aria-describedby="cockpit-command-hint" />
        <p className="cockpit-muted" id="cockpit-command-hint">{t.commandHint}</p>
      </>}
      {editor.type === 'edit' && <>
        <p className="cockpit-muted">{t.jsonHint}</p>
        <label htmlFor="cockpit-contract-json">{t.contractJson}</label>
        <textarea id="cockpit-contract-json" className="cockpit-json" name="json" required rows={18} spellCheck={false}
          defaultValue={contract?.document ? JSON.stringify(contract.document, null, 2) : ''} disabled={locked} autoFocus />
      </>}
      {editor.type === 'freeze' && <>
        <h3>{contract?.document?.title ?? contract?.id}</h3><p>{contract?.document?.objective}</p>
        <dl className="cockpit-facts">
          <div><dt>{t.maxSessions}</dt><dd>{contract?.document?.budget.max_sessions}</dd></div>
          <div><dt>{t.maxHours}</dt><dd>{contract?.document?.budget.max_hours}</dd></div>
        </dl>
        <ul className="cockpit-approval-list">{contract?.document?.milestones.flatMap((item) => item.criteria).map((item) =>
          <li key={item.id}><strong>{item.id}</strong><p>{item.description}</p>{item.check ? <pre>{item.check.command}</pre> : <span className="cockpit-muted">{t.manual}</span>}</li>)}</ul>
        <label className="cockpit-consent"><input type="checkbox" required disabled={locked} />{t.freezeHint}</label>
      </>}
      {editor.type === 'approve' && <><h3>{criterion?.id}</h3><p>{criterion?.description}</p><p>{t.approveHint}</p>
        <label className="cockpit-consent"><input type="checkbox" required disabled={locked} />{t.approve}</label></>}
      {(editor.type === 'freeze' || editor.type === 'approve') && <>
        <label htmlFor="cockpit-owner">{t.approvedBy}</label><input id="cockpit-owner" name="owner" required disabled={locked} autoComplete="name" />
      </>}
      {editor.type === 'amend' && <><label htmlFor="cockpit-amendment">{t.amendment}</label><textarea id="cockpit-amendment" name="summary" required rows={4} disabled={locked} autoFocus /></>}
      {issue && <p className="cockpit-warning" data-testid="cockpit-editor-error" role="alert">{issue}</p>}
      <div className="dialog-actions"><button type="button" className="button is-quiet" data-testid="cockpit-editor-cancel" onClick={close}>{t.cancel}</button>
        <button type="submit" className="button is-primary" data-testid="cockpit-editor-save" disabled={blocked}>{editor.type === 'freeze' ? t.freeze : editor.type === 'approve' ? t.approve : t.save}</button></div>
    </form>
  </Dialog>
}

export function CockpitView({ snapshot, error: loadError, lang, onCommand, onOpenSession, onPickFolder, onCopy }: Props) {
  const t = useT().cockpit
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [localLevel, setLocalLevel] = useState<CockpitLevel | null>(null)
  const project = snapshot?.projects.find((item) => item.id === selectedId) ?? snapshot?.projects[0] ?? null
  const level = localLevel ?? snapshot?.settings.level ?? 'overview'
  const locked = pending || !snapshot?.writable
  const perform: Perform = async (command) => {
    if (pending) return false
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      const result = await onCommand(command)
      if (!result.ok) { setError(result.error); return false }
      setNotice(result.message || t.saved)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally { setPending(false) }
  }
  const addProject = async () => {
    try {
      const root = await onPickFolder()
      if (root) await perform({ type: 'add-project', root })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const copy = (text: string) => {
    try { onCopy(text); setNotice(t.copied); setError(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const issue = error ?? loadError ?? snapshot?.error
  const waiting = snapshot?.projects.flatMap((item) => item.waiting.map((wait) => ({ project: item, wait }))) ?? []
  return (
    <div className="cockpit" data-testid="cockpit" aria-label={t.title} aria-busy={pending}>
      <div className="cockpit-toolbar">
        <div><h2>{t.title}</h2>{snapshot && <p className="cockpit-muted">{t.snapshotAt}: <time dateTime={snapshot.at}>{timestamp(snapshot.at, lang)}</time></p>}</div>
        <div className="cockpit-levels" role="group" aria-label={t.level}>
          {LEVELS.map((value) => <button type="button" key={value} data-testid={'cockpit-level-' + value} aria-pressed={level === value} disabled={pending || !snapshot}
            onClick={() => {
              if (!snapshot) return
              if (!snapshot.writable) { setLocalLevel(value); return }
              void perform({ type: 'save-settings', level: value, retentionDays: snapshot.settings.retentionDays }).then((ok) => {
                if (ok) setLocalLevel(null)
              })
            }}>{t.levels[value]}</button>)}
        </div>
        <div className="cockpit-actions">
          <button type="button" className="button is-quiet" disabled={pending} onClick={() => void perform({ type: 'refresh' })}>{t.refresh}</button>
          <button type="button" className="button is-primary" data-testid="cockpit-add-project" disabled={locked} onClick={() => void addProject()}><Icon name="plus" />{t.addProject}</button>
        </div>
      </div>
      {issue && <p className="cockpit-warning cockpit-message" role="alert"><strong>{t.error}: </strong>{issue}</p>}
      {notice && <p className="cockpit-message cockpit-notice" role="status">{notice}</p>}
      {snapshot && !snapshot.writable && <p className="cockpit-message cockpit-muted"><strong>{t.readonly}. </strong>{t.readonlyHint}</p>}
      {!snapshot ? <div className="cockpit-empty" role="status"><h3>{t.loading}</h3></div>
        : !project ? <div className="cockpit-empty"><Icon name="layers" /><h3>{t.emptyTitle}</h3><p>{t.emptyBody}</p></div>
        : <div className="cockpit-layout">
          <nav className="cockpit-projects" aria-label={t.projects}>
            <h3>{t.projects}</h3>
            {snapshot.projects.map((item) => <button type="button" className="cockpit-project" data-testid={'cockpit-project-' + item.id} key={item.id}
              aria-current={project.id === item.id ? 'page' : undefined}
              onClick={() => { setSelectedId(item.id); setEditor(null); setError(null); setNotice(null) }}>
              <strong>{item.name}</strong><Status state={item.state} />
              <span className="cockpit-project-counts">{item.sessions.filter((session) => session.state !== 'ended').length} {t.sessions} · {item.tasks.filter((task) => task.state !== 'done').length} {t.openTasksInline}</span>
            </button>)}
          </nav>
          <div className="cockpit-workspace">
            <section className={'cockpit-attention' + (waiting.length ? ' has-waiting' : '')} data-testid="cockpit-waiting" aria-labelledby="cockpit-waiting-title">
              <div className="cockpit-section-heading"><h3 id="cockpit-waiting-title">{t.waiting}</h3><span>{waiting.length}</span></div>
              {waiting.length === 0 ? <p className="cockpit-muted">{t.noWaiting}</p> : <ul>
                {waiting.map(({ project: origin, wait }) => {
                  const session = wait.sessionId ? origin.sessions.find((item) => item.id === wait.sessionId) : null
                  return <li key={String(origin.id) + ':' + wait.id}>
                    <div><p className="cockpit-wait-meta">{origin.name} · {session?.name ?? t.sources[wait.source]} · {t.waitingKinds[wait.kind]}</p>
                      <p>{wait.summary}</p>{!session && wait.ref && <code>{wait.ref}</code>}</div>
                    {wait.tileId
                      ? <button type="button" className="button is-quiet" onClick={() => onOpenSession(wait.tileId!)}>{t.answer}</button>
                      : <span className="cockpit-muted">{t.notInOrganizer}</span>}
                  </li>
                })}
              </ul>}
            </section>
            <div className="cockpit-content" key={project.id}>
              <header className="cockpit-project-heading">
                <div><h2>{project.name}</h2><p className="cockpit-path">{project.root}</p>
                  <p className="cockpit-muted">{t.branch}: {project.branch ?? t.noBranch}</p></div>
                <Status state={project.state} />
              </header>
              <dl className="cockpit-metrics">
                <div><dt>{t.activeSessions}</dt><dd>{project.sessions.filter((session) => session.state !== 'ended').length}</dd></div>
                <div><dt>{t.openTasks}</dt><dd>{project.tasks.filter((task) => task.state !== 'done').length}</dd></div>
                <div><dt>{t.contracts}</dt><dd>{project.contracts.length}</dd></div>
              </dl>
              {level !== 'overview' && <TaskBoard project={project} level={level} locked={locked} perform={perform} />}
              <Contracts project={project} level={level} locked={locked} lang={lang} perform={perform} edit={setEditor} copy={copy} />
              <section className="cockpit-section" aria-labelledby="cockpit-sessions-title">
                <h3 id="cockpit-sessions-title">{t.sessions}</h3>
                {project.sessions.length === 0 ? <p className="cockpit-muted">{t.noSessions}</p> : <ul className="cockpit-sessions">
                  {project.sessions.map((session) => <li key={session.id}>
                    <div><strong>{session.name}</strong><Status state={session.state} />
                      {level === 'details' && <p className="cockpit-muted">{t.version}: {session.version || '—'}{!session.supported ? ' · ' + t.unsupported : ''}<br />
                        {t.lastSeen}: {timestamp(session.updatedAt, lang)}{session.rawState ? ' · ' + t.rawState + ': ' + session.rawState : ''}</p>}</div>
                    <div className="cockpit-session-actions">
                      {level !== 'overview' && <>
                        <label className="sr-only" htmlFor={'cockpit-session-' + session.id}>{t.assignSession + ': ' + session.name}</label>
                        <select id={'cockpit-session-' + session.id} value={session.contractId ?? ''} disabled={locked}
                          onChange={(event) => void perform({ type: 'assign-session', projectId: project.id, sessionId: session.id, contractId: event.target.value || null })}>
                          <ContractOptions project={project} selected={session.contractId} />
                        </select>
                      </>}
                      {session.tileId ? <button type="button" className="button is-quiet" onClick={() => onOpenSession(session.tileId!)}>{t.answer}</button> : <span className="cockpit-muted">{t.notInOrganizer}</span>}
                    </div>
                  </li>)}
                </ul>}
              </section>
              {level === 'details' && <>
                <section className="cockpit-section" aria-labelledby="cockpit-events-title">
                  <h3 id="cockpit-events-title">{t.events}</h3>
                  {project.events.length === 0 ? <p className="cockpit-muted">{t.noEvents}</p> : <ol className="cockpit-events">
                    {project.events.map((event) => <li key={event.id}>
                      <time dateTime={event.at}>{timestamp(event.at, lang)}</time><span className="cockpit-muted">{t.sources[event.source]} · {event.kind}</span><p>{event.summary}</p>
                      {event.detail && <details><summary>{t.rawDetails}</summary><pre>{event.detail}</pre></details>}
                    </li>)}
                  </ol>}
                </section>
                <section className="cockpit-section" aria-labelledby="cockpit-sources-title">
                  <h3 id="cockpit-sources-title">{t.sourcesTitle}</h3>
                  <dl className="cockpit-source-list">{snapshot.adapters.map((adapter) => <div key={adapter.source}>
                    <dt>{t.sources[adapter.source]}</dt><dd><span className={'cockpit-source-health is-' + adapter.status}>{t.health[adapter.status]}</span><p>{adapter.detail}</p></dd>
                  </div>)}</dl>
                  <form className="cockpit-retention" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void perform({ type: 'save-settings', level, retentionDays: Number(data.get('days')) }) }}>
                    <label htmlFor="cockpit-retention-days">{t.retention}</label><input id="cockpit-retention-days" name="days" type="number" min="1" step="1" required defaultValue={snapshot.settings.retentionDays} disabled={locked} />
                    <button type="submit" className="button is-quiet" disabled={locked}>{t.saveRetention}</button>
                  </form>
                </section>
              </>}
              {(snapshot.adapters.find((adapter) => adapter.source === 'hook')?.status !== 'ok' || (level === 'details' && !!snapshot.pluginPath)) && <aside className="cockpit-plugin">
                <h3>{t.plugin}</h3><p className="cockpit-muted">{t.pluginHint}</p>
                {snapshot.pluginPath && <><code>{snapshot.pluginPath}</code><button type="button" className="button is-quiet" onClick={() => copy(snapshot.pluginPath!)}>{t.copyPath}</button></>}
              </aside>}
            </div>
          </div>
        </div>}
      {editor && project && editor.projectId === project.id && <ContractEditor key={editor.type + ':' + ('contractId' in editor ? editor.contractId : project.id)}
        editor={editor} project={project} locked={locked} actionError={error} perform={perform} close={() => setEditor(null)} />}
    </div>
  )
}
