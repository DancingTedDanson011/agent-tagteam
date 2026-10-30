import { spawn, type ChildProcess } from 'node:child_process'
import koffi from 'koffi'

// The host cannot start a user command until the parent has assigned its Job Object.
// Its environment is clean during startup; only the authorized command receives the original environment.
const HOST = `const {spawn}=require('node:child_process');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{try{const request=JSON.parse(input);const child=spawn(request.command,{cwd:process.cwd(),shell:request.shell,env:request.env,windowsHide:true,stdio:['ignore','inherit','inherit']});child.once('error',error=>{process.stderr.write(error.message);process.exit(1)});child.once('exit',code=>process.exit(code===null?1:code));}catch(error){process.stderr.write(error.message);process.exit(1)}});`

function bindWindowsJob() {
  const kernel = koffi.load('kernel32.dll')
  const basic = koffi.struct({ PerProcessUserTimeLimit: 'int64', PerJobUserTimeLimit: 'int64', LimitFlags: 'uint32',
    MinimumWorkingSetSize: 'uintptr', MaximumWorkingSetSize: 'uintptr', ActiveProcessLimit: 'uint32', Affinity: 'uintptr', PriorityClass: 'uint32', SchedulingClass: 'uint32' })
  const counters = koffi.struct({ ReadOperationCount: 'uint64', WriteOperationCount: 'uint64', OtherOperationCount: 'uint64', ReadTransferCount: 'uint64', WriteTransferCount: 'uint64', OtherTransferCount: 'uint64' })
  const extended = koffi.struct({ BasicLimitInformation: basic, IoInfo: counters, ProcessMemoryLimit: 'uintptr', JobMemoryLimit: 'uintptr', PeakProcessMemoryUsed: 'uintptr', PeakJobMemoryUsed: 'uintptr' })
  const create = kernel.func('void * __stdcall CreateJobObjectW(void *attributes, void *name)')
  const setInformation = kernel.func('int32 __stdcall SetInformationJobObject(void *job, int32 informationClass, void *information, uint32 size)')
  const openProcess = kernel.func('void * __stdcall OpenProcess(uint32 access, int32 inherit, uint32 pid)')
  const assign = kernel.func('int32 __stdcall AssignProcessToJobObject(void *job, void *process)')
  const terminate = kernel.func('int32 __stdcall TerminateJobObject(void *job, uint32 exitCode)')
  const close = kernel.func('int32 __stdcall CloseHandle(void *handle)')
  const lastError = kernel.func('uint32 __stdcall GetLastError()')
  const failure = (operation: string) => new Error(`${operation} failed (Windows error ${lastError()})`)
  return () => {
    let handle = create(null, null)
    if (!handle) throw failure('CreateJobObjectW')
    const dispose = () => { if (handle) { if (!close(handle)) throw failure('CloseHandle'); handle = null } }
    try {
      const limits = Buffer.alloc(koffi.sizeof(extended))
      limits.writeUInt32LE(0x2000, koffi.offsetof(extended, 'BasicLimitInformation') + koffi.offsetof(basic, 'LimitFlags'))
      if (!setInformation(handle, 9, limits, limits.byteLength)) throw failure('SetInformationJobObject')
    } catch (error) { dispose(); throw error }
    return {
      assign(pid: number) {
        const processHandle = openProcess(0x0101, 0, pid) // PROCESS_SET_QUOTA | PROCESS_TERMINATE
        if (!processHandle) throw failure('OpenProcess')
        try { if (!assign(handle, processHandle)) throw failure('AssignProcessToJobObject') }
        finally { if (!close(processHandle)) throw failure('CloseHandle') }
      },
      terminate() { if (handle && !terminate(handle, 1)) throw failure('TerminateJobObject') },
      dispose
    }
  }
}

const windowsJob = process.platform === 'win32' ? bindWindowsJob() : null
export type CheckProcess = { child: ChildProcess; started: Promise<void>; terminate(): void; dispose(): void }

export function createCheckProcess(command: string, root: string, shell: string): CheckProcess {
  if (!windowsJob) {
    const child = spawn(command, { cwd: root, shell, windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const terminate = () => {
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    return { child, started: Promise.resolve(), terminate, dispose: terminate }
  }
  const job = windowsJob()
  const originalEnv = { ...process.env }
  const env = { ...originalEnv }
  for (const key of Object.keys(env)) if (['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())) delete env[key]
  env.ELECTRON_RUN_AS_NODE = '1'
  let child: ChildProcess
  try { child = spawn(process.execPath, ['-e', HOST], { cwd: root, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] }) }
  catch (error) { job.dispose(); throw error }
  let stopped = false
  const started = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stdin!.once('error', reject)
    child.once('spawn', () => {
      try {
        if (stopped || !child.pid) throw new Error('Check cancelled before launch')
        job.assign(child.pid)
        child.stdin!.end(JSON.stringify({ command, shell, env: originalEnv }), resolve)
      } catch (error) { reject(error) }
    })
  })
  return { child, started, terminate() {
    stopped = true
    try { job.terminate() } finally { job.dispose(); if (child.exitCode === null && child.signalCode === null) child.kill() }
  }, dispose: job.dispose }
}
