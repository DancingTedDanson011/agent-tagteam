import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { ContractRepository } from './contracts'
import { CheckRunner } from './runner'
import { CockpitStore } from './store'

type CommandResult = { exitCode: number | null; stdout: string; stderr: string; error: string | null }
type CommandRunner = { command(command: string, root: string, shell: string, signal: AbortSignal): Promise<CommandResult> }
type Completion = { result: CommandResult } | { error: unknown }
const exec = promisify(execFile)
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}
const describeCompletion = (completion: Completion | null) => completion && ('result' in completion ? JSON.stringify(completion.result) : String(completion.error))

async function waitUntil(predicate: () => boolean, description: string, completion?: () => Completion | null): Promise<void> {
  const deadline = Date.now() + 8000
  while (!predicate()) {
    const early = completion?.()
    if (early) throw new Error(`Check completed before ${description}: ${describeCompletion(early)}`)
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await delay(20)
  }
}

async function stopFixtureChild(pid: number | null): Promise<void> {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) return
  try {
    if (process.platform === 'win32') await exec(join(process.env.SystemRoot!, 'System32', 'taskkill.exe'), ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
    else process.kill(pid, 'SIGKILL')
  } catch (error) { if (alive(pid)) throw error }
}

async function cleanup(actions: (() => unknown | Promise<unknown>)[], originalFailure: unknown): Promise<void> {
  const errors: unknown[] = []
  for (const action of actions) try { await action() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(originalFailure === undefined ? errors : [originalFailure, ...errors],
    `Process fixture cleanup failed${originalFailure === undefined ? '' : ` after: ${String(originalFailure)}`}`)
}

it.each(['timeout', 'cancel'] as const)('ends the whole check after its shell exits, including a pipe-holding child: %s', async (mode) => {
  const dir = mkdtempSync(join(tmpdir(), 'clio-check-tree-'))
  const pidPath = join(dir, 'child.pid')
  const launcherPidPath = join(dir, 'launcher.pid')
  const store = new CockpitStore(':memory:')
  const runner = new CheckRunner(store, new ContractRepository(store), mode === 'timeout' ? { timeoutMs: 1000 } : {})
  const controller = new AbortController()
  let pid: number | null = null
  let pending: Promise<Completion> | null = null
  let completion: Completion | null = null
  let originalFailure: unknown
  try {
    writeFileSync(join(dir, 'launcher.cjs'), `const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:${process.platform === 'win32'},stdio:['ignore',process.stdout,process.stderr],windowsHide:true});const publish=(name,value)=>{fs.writeFileSync(name+'.tmp',String(value));fs.renameSync(name+'.tmp',name)};publish('launcher.pid',process.pid);publish('child.pid',child.pid);setTimeout(()=>process.exit(0),100);`)
    const shell = process.platform === 'win32' ? join(process.env.SystemRoot!, 'System32', 'cmd.exe') : '/bin/sh'
    if (mode === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    pending = (runner as unknown as CommandRunner).command(`"${process.execPath}" launcher.cjs`, dir, shell, controller.signal).then(
      result => { completion = { result }; return completion },
      error => { completion = { error }; return completion })
    await waitUntil(() => existsSync(pidPath), 'fixture descendant marker', () => completion)
    const descendantMarker = readFileSync(pidPath, 'utf8')
    const descendantPid = Number(descendantMarker)
    pid = descendantPid
    const launcherMarker = readFileSync(launcherPidPath, 'utf8')
    const launcherPid = Number(launcherMarker)
    expect(Number.isSafeInteger(pid) && pid > 0, `Invalid descendant PID marker: ${JSON.stringify(descendantMarker)}`).toBe(true)
    expect(Number.isSafeInteger(launcherPid) && launcherPid > 0, `Invalid launcher PID marker: ${JSON.stringify(launcherMarker)}`).toBe(true)
    await waitUntil(() => !alive(launcherPid), 'fixture launcher exit', () => completion)
    expect(alive(pid), 'fixture descendant must still hold the pipes after its launcher exits').toBe(true)
    expect(completion, `check completed before its deadline/cancellation: ${describeCompletion(completion)}`).toBeNull()
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(1000)
    else controller.abort()
    await waitUntil(() => completion !== null, 'check completion after timeout/cancellation')
    const finished = await pending
    if ('error' in finished) throw finished.error
    expect(finished.result.error).toMatch(mode === 'timeout' ? /timeout/i : /cancel/i)
    await waitUntil(() => !alive(descendantPid), 'fixture descendant termination')
    expect(alive(pid), 'check descendant survived timeout/cancellation').toBe(false)
  } catch (error) { originalFailure = error; throw error }
  finally {
    await cleanup([
      () => controller.abort(),
      () => stopFixtureChild(pid),
      async () => { if (vi.isFakeTimers()) await vi.runAllTimersAsync() },
      async () => { if (pending) { const finished = await pending; if ('error' in finished) throw finished.error } },
      () => runner.close(),
      () => store.close(),
      () => vi.useRealTimers(),
      () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    ], originalFailure)
  }
}, 25000)

it('cleans up disconnected background work on ordinary completion and preserves the shell exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clio-check-finish-'))
  const store = new CockpitStore(':memory:')
  const runner = new CheckRunner(store, new ContractRepository(store))
  let pid: number | null = null
  let originalFailure: unknown
  try {
    writeFileSync(join(dir, 'launcher.cjs'), `const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:${process.platform === 'win32'},stdio:'ignore',windowsHide:true});fs.writeFileSync('child.pid',String(child.pid));setTimeout(()=>process.exit(7),100);`)
    const shell = process.platform === 'win32' ? join(process.env.SystemRoot!, 'System32', 'cmd.exe') : '/bin/sh'
    const result = await (runner as unknown as CommandRunner).command(`"${process.execPath}" launcher.cjs`, dir, shell, new AbortController().signal)
    const descendantPid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'))
    pid = descendantPid
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
    expect(result.exitCode).toBe(7)
    expect(result.error).toBeNull()
    await waitUntil(() => !alive(descendantPid), 'disconnected fixture descendant termination')
    expect(alive(pid)).toBe(false)
  } catch (error) { originalFailure = error; throw error }
  finally {
    await cleanup([() => stopFixtureChild(pid), () => runner.close(), () => store.close(),
      () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })], originalFailure)
  }
}, 15000)

async function isolatedPublicRun(dir: string, projectRoot: string, stream: 'stdout' | 'stderr' | null, defaultGit = false) {
  const modules = fileURLToPath(new URL('./', import.meta.url))
  const typescript = createRequire(import.meta.url).resolve('typescript')
  const driver = join(dir, 'public-check-driver.cjs')
  writeFileSync(driver, `
const fs=require('node:fs'),path=require('node:path'),ts=require(${JSON.stringify(typescript)});
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const projectRoot=${JSON.stringify(projectRoot)},stream=${JSON.stringify(stream)},defaultGit=${JSON.stringify(defaultGit)};
const transport=require(${JSON.stringify(join(modules, 'check-process.ts'))}),original=transport.createCheckProcess;
let injected=false,poll=null,pid=null;
const marker=path.join(projectRoot,'.code-guardian-pipe-child.pid');
if(stream)transport.createCheckProcess=(...args)=>{const tree=original(...args);poll=setInterval(()=>{if(!fs.existsSync(marker))return;const raw=fs.readFileSync(marker,'utf8');if(!/^[0-9]+$/.test(raw))return;pid=Number(raw);clearInterval(poll);injected=true;tree.child[stream].destroy(Object.assign(new Error('read ENOTCONN ('+stream+')'),{code:'ENOTCONN'}));},20);return tree;};
const {CockpitStore}=require(${JSON.stringify(join(modules, 'store.ts'))});
const {ContractRepository}=require(${JSON.stringify(join(modules, 'contracts.ts'))});
const {CheckRunner}=require(${JSON.stringify(join(modules, 'runner.ts'))});
const alive=pid=>{try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}};
(async()=>{
 const store=new CockpitStore(':memory:'),repository=new ContractRepository(store);
 let runner=new CheckRunner(store,repository,{timeoutMs:15000,gitPath:null});
 try{
  if(stream)fs.writeFileSync(path.join(projectRoot,'check.cjs'),"const fs=require('node:fs');fs.writeFileSync('.code-guardian-pipe-child.pid.tmp',String(process.pid));fs.renameSync('.code-guardian-pipe-child.pid.tmp','.code-guardian-pipe-child.pid');setInterval(()=>{},1000)");
  const project=store.ensureProject(projectRoot),command=stream?'"'+process.execPath+'" check.cjs':'echo LONG-CWD-CHECK';
  const draft=await repository.create(project.id,{title:'Pipe failure proof',objective:'Finish checks even when process transport fails',maxSessions:2,maxHours:1,command});
  await repository.freeze(project.id,draft.id,'Owner',draft.definitionHash);
  if(defaultGit){await runner.close();runner=new CheckRunner(store,repository,{timeoutMs:15000})}
  const run=await runner.run(project.id,draft.id,'AC1');
  if(stream&&!injected)throw new Error('Fixture did not reach its real output pipe: '+JSON.stringify(run));
  const deadline=Date.now()+5000;while(pid&&alive(pid)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  process.stdout.write(JSON.stringify({run,stored:store.runs(project.id,draft.id)[0],injected,descendantAlive:pid?alive(pid):false,projectLength:project.rootPath.length})+'\\n');
 }finally{if(poll)clearInterval(poll);await runner.close();store.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
`)
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.NODE_OPTIONS
  const result = await exec(process.execPath, [driver], { cwd: dir, env, windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 })
  return JSON.parse(result.stdout.trim()) as { run: { passed: boolean; error: string | null; exitCode: number | null; finishedAt: string | null }; stored: { passed: boolean; error: string | null; finishedAt: string | null }; injected: boolean; descendantAlive: boolean; projectLength: number }
}

it.each(['stdout', 'stderr'] as const)('records real %s pipe errors as finished failures without crashing the runner process', async (stream) => {
  const dir = mkdtempSync(join(tmpdir(), 'clio-check-pipe-'))
  const project = join(dir, 'project')
  mkdirSync(project)
  let originalFailure: unknown
  try {
    const result = await isolatedPublicRun(dir, project, stream)
    expect(result.injected).toBe(true)
    expect(result.run.finishedAt).not.toBeNull()
    expect(result.run.passed).toBe(false)
    expect(result.run.error).toContain('ENOTCONN')
    expect(result.stored.finishedAt).not.toBeNull()
    expect(result.stored.passed).toBe(false)
    expect(result.stored.error).toBe(result.run.error)
    expect(result.descendantAlive).toBe(false)
  } catch (error) { originalFailure = error; throw error }
  finally { await cleanup([() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })], originalFailure) }
}, 30000)

it.each(['disabled', 'default'] as const)('keeps an accepted long project folder within the public finished-run boundary (Git %s)', async (git) => {
  const dir = mkdtempSync(join(tmpdir(), 'clio-check-long-'))
  let project = dir
  while (project.length < 324) project = join(project, 'project-segment-' + 'x'.repeat(40))
  mkdirSync(project, { recursive: true })
  let originalFailure: unknown
  try {
    const result = await isolatedPublicRun(dir, project, null, git === 'default')
    expect(result.projectLength).toBeGreaterThanOrEqual(324)
    expect(result.run.finishedAt).not.toBeNull()
    expect(result.stored.finishedAt).not.toBeNull()
    expect(result.stored.passed).toBe(result.run.passed)
    if (result.run.passed) expect(result.run.exitCode).toBe(0)
    else expect(result.run.error !== null || result.run.exitCode !== 0).toBe(true)
  } catch (error) { originalFailure = error; throw error }
  finally { await cleanup([() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })], originalFailure) }
}, 30000)

it.each([undefined, '1'])('runs the command with its original environment while preventing host preloads (Electron flag %s)', async (electronFlag) => {
  const dir = mkdtempSync(join(tmpdir(), 'clio-check-env-'))
  const keys = ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'] as const
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const store = new CockpitStore(':memory:')
  const runner = new CheckRunner(store, new ContractRepository(store))
  let originalFailure: unknown
  try {
    const preload = join(dir, 'preload.cjs')
    writeFileSync(preload, "process.stdout.write('AUTHORIZED-PRELOAD\\n')")
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
    process.env.NODE_PATH = join(dir, 'fixture-node-path')
    if (electronFlag === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = electronFlag
    const expected = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    writeFileSync(join(dir, 'environment.cjs'), `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,process.env[key]]))))`)
    const shell = process.platform === 'win32' ? join(process.env.SystemRoot!, 'System32', 'cmd.exe') : '/bin/sh'
    const result = await (runner as unknown as CommandRunner).command(`"${process.execPath}" environment.cjs`, dir, shell, new AbortController().signal)
    expect(result.error).toBeNull()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('AUTHORIZED-PRELOAD\n' + JSON.stringify(expected))
    expect(result.stderr).toBe('')
  } catch (error) { originalFailure = error; throw error }
  finally {
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] }
    await cleanup([() => runner.close(), () => store.close(),
      () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })], originalFailure)
  }
}, 15000)
