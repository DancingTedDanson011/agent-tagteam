import { isAbsolute, toNamespacedPath } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import koffi from 'koffi'

export type SourceWatchEvent = {
  path: string
  kind: 'file' | 'directory'
  action: 'added' | 'removed' | 'modified' | 'renamed_from' | 'renamed_to'
}
const actions: Record<number, SourceWatchEvent['action']> = { 1: 'added', 2: 'removed', 3: 'modified', 4: 'renamed_from', 5: 'renamed_to' }
const header = koffi.struct({ NextEntryOffset: 'uint32', Action: 'uint32', FileNameLength: 'uint32' })
const headerSize = koffi.sizeof(header)

/** FILE_NOTIFY_INFORMATION is DWORD-aligned, followed by a byte-counted UTF-16 name. */
export function decodeSourceChanges(buffer: Buffer, bytes: number, kind: SourceWatchEvent['kind']): SourceWatchEvent[] {
  if (bytes === 0) throw new Error('Source notification buffer overflow')
  if (!Number.isSafeInteger(bytes) || bytes < headerSize || bytes > buffer.length) throw new Error('Invalid source notification length')
  const events: SourceWatchEvent[] = []
  let offset = 0
  while (offset < bytes) {
    if (bytes - offset < headerSize) throw new Error('Truncated source notification')
    const next = buffer.readUInt32LE(offset + koffi.offsetof(header, 'NextEntryOffset'))
    const action = actions[buffer.readUInt32LE(offset + koffi.offsetof(header, 'Action'))]
    const length = buffer.readUInt32LE(offset + koffi.offsetof(header, 'FileNameLength'))
    const size = headerSize + length
    if (!action || !length || length % 2 || size > bytes - offset || (next !== 0 && (next % 4 || next < size || next >= bytes - offset))) throw new Error('Invalid source notification record')
    const path = buffer.toString('utf16le', offset + headerSize, offset + size).replace(/\\/g, '/')
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid source notification path')
    events.push({ path, kind, action })
    if (next === 0) {
      if (bytes - offset - size > 3) throw new Error('Invalid source notification tail')
      break
    }
    offset += next
  }
  return events
}

function bindWindowsWatch() {
  const kernel = koffi.load('kernel32.dll')
  const overlappedType = koffi.struct({ Internal: 'uintptr', InternalHigh: 'uintptr', Offset: 'uint32', OffsetHigh: 'uint32', hEvent: 'void *' })
  const createFile = kernel.func('void * __stdcall CreateFileW(str16 path, uint32 access, uint32 share, void *security, uint32 creation, uint32 flags, void *templateFile)')
  const createEvent = kernel.func('void * __stdcall CreateEventW(void *security, int32 manualReset, int32 initialState, void *name)')
  const readChanges = kernel.func('int32 __stdcall ReadDirectoryChangesW(void *directory, void *buffer, uint32 length, int32 recursive, uint32 filter, void *bytes, void *overlapped, void *completion)')
  const getResult = kernel.func('int32 __stdcall GetOverlappedResult(void *directory, void *overlapped, _Out_ uint32 *bytes, int32 wait)')
  const cancel = kernel.func('int32 __stdcall CancelIoEx(void *directory, void *overlapped)')
  const closeHandle = kernel.func('int32 __stdcall CloseHandle(void *handle)')
  const lastError = kernel.func('uint32 __stdcall GetLastError()')
  const invalidHandle = (1n << BigInt(koffi.sizeof('void *') * 8)) - 1n
  const failure = (operation: string, code = lastError()) => new Error(`${operation} failed (Windows error ${code})`)
  type Stream = { handle: unknown; event: unknown; overlapped: Buffer; buffer: Buffer; kind: SourceWatchEvent['kind']; filter: number; pending: boolean; cancelling: boolean }
  const outstandingCleanup = new Set<Promise<void>>()

  return (root: string, onEvent: (event: SourceWatchEvent) => void, onError: (error: Error) => void): { close(): Promise<void> } => {
    if (outstandingCleanup.size) throw new Error('Previous source observation cancellation is still outstanding')
    const streams: Stream[] = []
    let failed: Error | null = null
    let closing = false
    let timer: ReturnType<typeof setInterval> | null = null
    let closePromise: Promise<void> | null = null
    const report = (value: unknown) => {
      const error = value instanceof Error ? value : new Error(String(value))
      if (failed) return
      failed = error
      try { onError(error) } catch (callbackError) { failed = new AggregateError([error, callbackError], 'Source observation callback failed') }
    }
    const release = (stream: Stream) => {
      for (const key of ['handle', 'event'] as const) {
        if (stream[key]) {
          const handle = stream[key]; stream[key] = null
          try { if (!closeHandle(handle)) report(failure('CloseHandle')) } catch (error) { report(error) }
        }
      }
    }
    const queue = (stream: Stream) => {
      stream.overlapped.fill(0)
      koffi.encode(stream.overlapped, koffi.offsetof(overlappedType, 'hEvent'), 'void *', stream.event)
      stream.cancelling = false
      if (!readChanges(stream.handle, stream.buffer, stream.buffer.length, 1, stream.filter, null, stream.overlapped, null)) throw failure('ReadDirectoryChangesW')
      stream.pending = true
    }
    // CancelIoEx does not finish I/O. Only a completed GetOverlappedResult permits releasing these buffers.
    const complete = (stream: Stream): boolean => {
      if (!stream.pending) return true
      const bytes = [0]
      if (!getResult(stream.handle, stream.overlapped, bytes, 0)) {
        const code = lastError()
        if (code === 996) return false // ERROR_IO_INCOMPLETE
        stream.pending = false
        if (code !== 995 || !closing) report(failure('GetOverlappedResult', code)) // ERROR_OPERATION_ABORTED
        return true
      }
      stream.pending = false
      try { for (const event of decodeSourceChanges(stream.buffer, bytes[0], stream.kind)) if (!failed) onEvent(event) } catch (error) { report(error) }
      return true
    }
    try {
      for (const [kind, filter] of [['file', 1], ['directory', 2]] as const) {
        // Separate kernel filters retain the object kind even when the path has vanished or been reused.
        const handle = createFile(toNamespacedPath(root), 1, 7, null, 3, 0x02000000 | 0x40000000, null)
        if (!handle || koffi.address(handle) === invalidHandle) throw failure('CreateFileW')
        const event = createEvent(null, 1, 0, null)
        if (!event) { const error = failure('CreateEventW'); if (!closeHandle(handle)) report(failure('CloseHandle')); throw error }
        const stream: Stream = { handle, event, overlapped: Buffer.alloc(koffi.sizeof(overlappedType)), buffer: Buffer.alloc(65536), kind, filter, pending: false, cancelling: false }
        streams.push(stream)
        queue(stream)
      }
      timer = setInterval(() => {
        if (closing || failed) return
        for (const stream of streams) {
          try { if (complete(stream) && !failed) queue(stream) } catch (error) { report(error) }
        }
      }, 10)
      timer.unref()
    } catch (error) { report(error) }

    const finishStream = async (stream: Stream): Promise<void> => {
      let batch = 0
      for (;;) {
        try {
          if (!stream.pending) break
          if (complete(stream)) {
            if (failed || stream.cancelling) break
            queue(stream)
            batch++
            if (batch >= 16) { batch = 0; await delay(0, undefined, { ref: false }) }
            continue
          }
          if (!stream.cancelling) {
            stream.cancelling = true
            if (!cancel(stream.handle, stream.overlapped)) {
              const code = lastError()
              if (code !== 1168) report(failure('CancelIoEx', code)) // ERROR_NOT_FOUND: completion raced cancellation
            }
          }
        } catch (error) {
          report(error)
          if (!stream.pending) break
          // An interop exception must not let a live OVERLAPPED buffer become unreachable.
          if (!stream.cancelling) {
            stream.cancelling = true
            try { cancel(stream.handle, stream.overlapped) } catch (cancelError) { report(cancelError) }
          }
        }
        await delay(5, undefined, { ref: false })
      }
      release(stream)
    }
    return { close() {
      if (closePromise) return closePromise
      closing = true
      if (timer) clearInterval(timer)
      // This continuation owns all buffers until completion, including delayed driver cancellation.
      const cleanup = Promise.all(streams.map(finishStream)).then(() => {})
      let deadline: ReturnType<typeof setTimeout> | null = null
      closePromise = Promise.race([
        cleanup,
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => {
          const error = new Error('Source observation cancellation did not complete before its deadline')
          outstandingCleanup.add(cleanup)
          void cleanup.then(() => outstandingCleanup.delete(cleanup), () => outstandingCleanup.delete(cleanup))
          report(error); reject(error)
        }, 5000) })
      ]).finally(() => { if (deadline) clearTimeout(deadline) }).then(() => { if (failed) throw failed })
      return closePromise
    } }
  }
}

const startWindowsWatch = process.platform === 'win32' ? bindWindowsWatch() : null

export function startNativeSourceWatch(root: string, onEvent: (event: SourceWatchEvent) => void, onError: (error: Error) => void): { close(): Promise<void> } {
  if (!startWindowsWatch) throw new Error('Native source observations require Windows')
  return startWindowsWatch(root, onEvent, onError)
}
