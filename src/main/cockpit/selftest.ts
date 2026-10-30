// Real Electron/preload/IPC/SQLite/shell checks. All fixtures live in the isolated selftest home.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CockpitCommand, CockpitResult, CockpitSnapshot, ContractView } from '../../shared/cockpit'
import type { RestoreResult } from '../../shared/types'
import type { SelftestContext } from '../selftest'
import { parentPid } from '../win32/process-cwd'
import { sameDirectory } from '../fsutil'
import * as win from '../win32/windows'
import * as api from '../win32/api'

type Check = (name: string, ok: boolean, detail?: string) => void
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function cockpitChecks(ctx: SelftestContext, check: Check): Promise<void> {
  const js = <T>(code: string): Promise<T> => ctx.window.webContents.executeJavaScript(code, true)
  const snapshot = () => js<CockpitSnapshot>('window.organizer.loadCockpit()')
  const command = async (value: CockpitCommand) => {
    const result = await js<CockpitResult>(`window.organizer.cockpitCommand(${JSON.stringify(value)})`)
    if (!result.ok) throw new Error(result.error)
  }
  const click = (selector: string) => js<boolean>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) return false; e.click(); return true })()`)
  const clickText = (scope: string, labels: string[]) => js<boolean>(`(() => {
    const e = [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll('button') ?? [])]
      .find(button => ${JSON.stringify(labels)}.includes(button.textContent.trim()));
    if (!e || e.disabled) return false; e.click(); return true;
  })()`)
  const until = async (condition: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 15000
    while (!(await condition())) { if (Date.now() > deadline) throw new Error(label); await pause(100) }
  }
  const fill = (selector: string, value: string) => js<void>(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing input');
    const p = e.tagName === 'SELECT' ? HTMLSelectElement.prototype
      : e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p, 'value').set.call(e, ${JSON.stringify(value)});
    e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  let ownWindow: bigint | null = null
  let ownTile: string | null = null
  let registryFile: string | null = null
  try {
    await until(async () => (await snapshot()).writable, 'Cockpit writer did not become ready')
    await js(`(() => { const b = [...document.querySelectorAll('.view-button')].find(e => e.textContent.includes('Cockpit')); if (!b) throw Error('Missing Cockpit navigation'); b.click() })()`)
    await until(() => js<boolean>(`!!document.querySelector('[data-testid="cockpit"]')`), 'Cockpit view missing')
    check('cockpit: opens without a captured tile through real navigation', ctx.sessions.list().length === 0)
    ctx.window.webContents.focus()
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: '1', modifiers: ['control'] })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: '1', modifiers: ['control'] })
    await until(() => js<boolean>(`!document.querySelector('[data-testid="cockpit"]')`), 'Focus shortcut did not leave the cockpit')
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: '5', modifiers: ['control'] })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: '5', modifiers: ['control'] })
    await until(() => js<boolean>(`!!document.querySelector('[data-testid="cockpit"]')`), 'Cockpit shortcut did not open without tiles')
    check('cockpit: keyboard shortcuts switch to and from the view without tiles', true)

    const dataDir = dirname(ctx.journalPath)
    const pluginPath = (await snapshot()).pluginPath
    check('cockpit: displayed optional plugin path is persistent app data', !!pluginPath && sameDirectory(pluginPath, join(dataDir, 'cockpit-plugin')))
    const requestedRoot = join(dataDir, 'cockpit-test-project')
    mkdirSync(requestedRoot, { recursive: true })
    const projectRoot = realpathSync.native(requestedRoot)
    writeFileSync(join(projectRoot, 'main.rs'), 'fn main() { println!("fixture"); }\n')
    await command({ type: 'add-project', root: projectRoot })
    const project = (await snapshot()).projects.find(item => item.root.toLowerCase() === projectRoot.toLowerCase())
    if (!project) throw new Error('Added project missing')
    await command({ type: 'save-settings', level: 'board', retentionDays: 30 })
    await until(() => js<boolean>(`!!document.querySelector('[data-testid="cockpit-task-title"]')`), 'Task form missing')
    await fill('[data-testid="cockpit-task-title"]', 'Electron task fixture')
    await js(`document.querySelector('[data-testid="cockpit-create-task"]').requestSubmit()`)
    await until(async () => !!(await snapshot()).projects.find(item => item.id === project.id)?.tasks.some(task => task.title === 'Electron task fixture'), 'Task not persisted')
    const task = (await snapshot()).projects.find(item => item.id === project.id)!.tasks.find(item => item.title === 'Electron task fixture')!
    await fill(`[data-testid="cockpit-task-state-${task.id}"]`, 'done')
    await until(async () => (await snapshot()).projects.find(item => item.id === project.id)?.tasks.find(item => item.id === task.id)?.state === 'done', 'Task state not persisted')
    check('cockpit: real form creates and moves a persisted task', true)

    await until(() => click('[data-testid="cockpit-create-contract"]'), 'New contract action missing')
    const editor = '[data-testid="cockpit-contract-editor"]'
    await until(() => js<boolean>(`!!document.querySelector(${JSON.stringify(editor)})`), 'Contract editor missing')
    await fill('[data-testid="cockpit-contract-title"]', 'Electron delivery fixture')
    await fill('[data-testid="cockpit-contract-objective"]', 'Execute an actual shell check and require a separate human check')
    await fill('[data-testid="cockpit-contract-sessions"]', '2')
    await fill('[data-testid="cockpit-contract-hours"]', '1')
    await fill('[data-testid="cockpit-contract-command"]', 'echo CLIO-COCKPIT-CHECK && cd')
    await js(`document.querySelector(${JSON.stringify(editor)}).requestSubmit()`)
    await until(async () => !!(await snapshot()).projects.find(item => item.id === project.id)?.contracts.length, 'Contract form did not persist the draft')
    const current = async (): Promise<ContractView> => {
      const value = (await snapshot()).projects.find(item => item.id === project.id)?.contracts[0]
      if (!value) throw new Error('Contract missing')
      return value
    }
    let contract = await current()
    check('cockpit: real contract editor persists an unapproved draft', contract.document?.title === 'Electron delivery fixture' && contract.document.objective === 'Execute an actual shell check and require a separate human check' && contract.document.status === 'draft' && !contract.freeze && contract.runs.length === 0)
    const contractSelector = `[data-testid="cockpit-contract-${contract.id}"]`
    const approveDialog = async (label: string, remainsUnapproved: () => Promise<boolean>) => {
      await until(() => js<boolean>(`!!document.querySelector(${JSON.stringify(editor)})`), 'Approval dialog missing')
      const ownerBlocks = await js<boolean>(`(() => {
        const form = document.querySelector(${JSON.stringify(editor)});
        const owner = form.querySelector('#cockpit-owner');
        form.querySelector('.cockpit-consent input').click();
        form.requestSubmit();
        return owner.required && !owner.value && !form.checkValidity();
      })()`)
      await pause(100)
      const ownerUnapproved = await remainsUnapproved()
      if (!await click('.cockpit-consent input')) throw new Error('Approval consent checkbox missing')
      await fill('#cockpit-owner', 'Selftest fixture')
      const consentBlocks = await js<boolean>(`(() => {
        const form = document.querySelector(${JSON.stringify(editor)});
        const consent = form.querySelector('.cockpit-consent input');
        form.requestSubmit();
        return consent.required && !consent.checked && !form.checkValidity();
      })()`)
      await pause(100)
      const blocked = ownerBlocks && ownerUnapproved && consentBlocks && await remainsUnapproved()
      check(`cockpit: ${label} requires an owner and explicit consent in the real dialog`, blocked)
      if (!blocked) throw new Error('Approval dialog accepted a submission without explicit consent')
      if (!await click('.cockpit-consent input')) throw new Error('Approval consent checkbox missing')
      await js(`document.querySelector(${JSON.stringify(editor)}).requestSubmit()`)
      await until(() => js<boolean>(`!document.querySelector(${JSON.stringify(editor)})`), 'Approval dialog did not close after consent')
    }
    await until(() => clickText(contractSelector, ['Vertrag freigeben', 'Approve contract']), 'Contract approval action missing')
    await approveDialog('contract approval', async () => !(await current()).freeze)
    await until(async () => !!(await current()).freeze, 'Contract approval did not persist')
    const run = async () => {
      const priorRunId = (await current()).runs[0]?.id
      await until(() => clickText(contractSelector, ['Kriterien prüfen', 'Check criteria']), 'Run criteria action unavailable')
      await until(async () => { const value = await current(); return !value.running && value.runs[0]?.id !== priorRunId && value.runs[0]?.finishedAt !== null }, 'Actual check did not finish')
      return current()
    }
    contract = await run()
    const actual = contract.runs[0]
    check('cockpit: shell check records actual cwd output and exit status', actual?.passed === true && actual.exitCode === 0 && actual.stdout.includes('CLIO-COCKPIT-CHECK') && actual.stdout.toLowerCase().includes(projectRoot.toLowerCase()), JSON.stringify(actual))
    check('cockpit: passing shell alone does not approve manual criterion', !contract.fulfilled && contract.manualApprovals.length === 0)
    const oldStamp = contract.sourceFingerprint
    writeFileSync(join(projectRoot, 'main.rs'), 'fn main() { panic!("changed"); }\n')
    await until(async () => { await command({ type: 'refresh' }); return (await current()).sourceFingerprint !== oldStamp }, 'Changed Rust source did not invalidate evidence')
    check('cockpit: changed source invalidates a previous successful check', (await current()).progress.met === 0)
    contract = await run()
    if (!await click('[data-testid="cockpit-level-details"]')) throw new Error('Contract details action missing')
    await until(() => clickText(contractSelector, ['Kriterium abnehmen', 'Approve criterion']), 'Manual criterion approval action missing')
    await approveDialog('manual criterion approval', async () => (await current()).manualApprovals.length === 0)
    await until(async () => (await current()).manualApprovals.length > 0, 'Manual approval did not persist')
    contract = await current()
    const exported = JSON.parse(readFileSync(contract.path, 'utf8'))
    check('cockpit: current checks plus explicit local manual approval complete the contract', contract.fulfilled && exported.status === 'fulfilled' && exported.milestones[0].criteria.every((criterion: { status: string }) => criterion.status === 'met'))
    await command({ type: 'save-settings', level: 'details', retentionDays: 30 })
    await pause(200)
    writeFileSync(join(dataDir, 'cockpit-electron.png'), (await ctx.window.webContents.capturePage()).toPNG())

    const restored = await js<RestoreResult>(`window.organizer.restoreSlot({ launch: { kind: 'window', host: 'conhost', shell: 'cmd', cwd: ${JSON.stringify(projectRoot)} }, label: 'CLIO-COCKPIT-NATIVE' }, false)`)
    if (!restored.ok) throw new Error('Native fixture did not restore')
    ownTile = restored.id
    ownWindow = ctx.sessions.get(ownTile)!.hwnd
    const ownerPid = win.getPid(ownWindow)
    const ancestor = parentPid(ownerPid)
    const pid = ancestor && ancestor !== process.pid ? ancestor : ownerPid
    const procStart = win.processStartTime(pid)
    if (!procStart) throw new Error('Native fixture process identity unavailable')
    const registryDir = join(dataDir, 'home', '.claude', 'sessions')
    mkdirSync(registryDir, { recursive: true })
    registryFile = join(registryDir, `${pid}.json`)
    writeFileSync(registryFile, JSON.stringify({ pid, procStart, sessionId: 'cockpit-native-fixture', cwd: projectRoot, version: '2.1.312', status: 'waiting', waitingFor: 'permission', startedAt: Date.now(), updatedAt: Date.now() }))
    await until(async () => { await command({ type: 'refresh' }); return (await snapshot()).projects.some(item => item.waiting.some(wait => wait.sessionId === 'cockpit-native-fixture' && wait.tileId === ownTile)) }, 'Waiting native fixture did not map to its exact tile')
    await until(() => js<boolean>(`!!document.querySelector('[data-testid="cockpit-waiting"] button')`), 'Waiting tile action missing')
    await click('[data-testid="cockpit-waiting"] button')
    await until(async () => ctx.placer.current().attended.includes(ownTile!), 'Waiting action did not attend its tile')
    check('cockpit: real waiting action focuses its own classic console tile', true, JSON.stringify({ ownerPid, registryPid: pid, tileId: ownTile }))
  } catch (error) {
    check('cockpit: integrated Electron flow', false, error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    if (registryFile) rmSync(registryFile, { force: true })
    if (ownTile) await ctx.sessions.release(ownTile)
    if (ownWindow && win.isWindow(ownWindow)) api.PostMessageW(ownWindow, 0x0010, 0n, 0n)
    await js(`(() => { const e = [...document.querySelectorAll('.view-button')].find(b => b.textContent.includes('Fokus')); e?.click() })()`)
    await pause(400)
  }
}
