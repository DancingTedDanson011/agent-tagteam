// Standalone plugin: imports only Node builtins. Never prints a hook decision or starts an app.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const MAX_BYTES = 256 * 1024
const MAX_FILES = 2048
const ownName = name => /^cockpit-[A-Za-z0-9-]+\.json$/.test(name)
const decodedKey = key => key.replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
const sensitiveKey = key => /password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|socket|thinking|reasoning/i.test(decodedKey(key))
function maskEncodedJsonCredentials(value) {
  for (const match of value.matchAll(/\\"((?:\\+u[0-9a-f]{4}|[A-Za-z0-9_.-])+)\\"\s*:/gi)) {
    const key = match[1].replace(/\\+u([0-9a-f]{4})/gi, (_part, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    if (sensitiveKey(key)) return value.slice(0, match.index) + '****'
  }
  return value
}
function maskEmbeddedCredentials(value) {
  for (const match of value.matchAll(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*:/g)) {
    if (sensitiveKey(match[1].slice(1, -1))) return value.slice(0, match.index + match[0].length) + '"****"'
  }
  return value
}

function mask(value) {
  return maskEmbeddedCredentials(maskEncodedJsonCredentials(value))
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '****')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '****')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '****')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '****')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '****')
    .replace(/(?<![A-Za-z0-9_.-])["']?(?=[A-Za-z0-9_.-]+["']?\s*[=:])[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)[A-Za-z0-9_.-]*["']?\s*[=:]\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|[^\r\n]*)/gi, '****')
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{12,}/g, '****')
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, '****')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/g, '')
    .slice(0, 3000)
}
function sanitize(value, depth = 0) {
  if (depth > 6) return '[depth limit]'
  if (typeof value === 'string') return mask(value)
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (Array.isArray(value)) return value.slice(0, 64).map(item => sanitize(item, depth + 1))
  if (!value || typeof value !== 'object') return '[unsupported]'
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [mask(key).slice(0, 100),
    sensitiveKey(key) ? '****' : sanitize(item, depth + 1)]))
}
function writeAtomic(dir, name, payload) {
  const file = path.join(dir, name)
  const tmp = file + '.' + crypto.randomUUID() + '.tmp'
  let fd
  try {
    fd = fs.openSync(tmp, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify(payload))
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    fs.renameSync(tmp, file)
    return file
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* The app ignores unfinished tmp files. */ }
  }
}
function spoolPayload(value, dir = path.join(os.homedir(), '.cli-organizer', 'cockpit-spool')) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const count = fs.readdirSync(dir).filter(ownName).length
  const at = new Date().toISOString()
  if (count >= MAX_FILES) return writeAtomic(dir, 'cockpit-backpressure.json', { cockpit_invalid: 'Spool is full; observations were dropped', cockpit_recorded_at: at })
  const unsafeIdentity = value && typeof value === 'object' && ['cwd', 'session_id', 'procStart'].some(key => typeof value[key] === 'string' && mask(value[key]) !== value[key])
  const clean = unsafeIdentity ? { cockpit_invalid: 'Unsafe hook identity field' } : sanitize(value)
  let payload = clean && typeof clean === 'object' && !Array.isArray(clean) ? { ...clean, cockpit_recorded_at: at } : { cockpit_invalid: 'Hook payload is not an object', cockpit_recorded_at: at }
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES) payload = { cockpit_invalid: 'Sanitized hook payload exceeds byte limit', cockpit_recorded_at: at }
  return writeAtomic(dir, `cockpit-${Date.now()}-${crypto.randomUUID()}.json`, payload)
}
module.exports = { spoolPayload, sanitize }

if (require.main === module) {
  const requested = process.argv[2] === '--spool-dir' ? process.argv[3] : undefined
  const dir = requested && path.isAbsolute(requested) ? requested : undefined
  let length = 0
  const chunks = []
  process.stdin.on('data', chunk => {
    length += chunk.length
    if (length <= MAX_BYTES) chunks.push(chunk)
  })
  process.stdin.on('end', () => {
    try {
      let payload
      if (length > MAX_BYTES) payload = { cockpit_invalid: 'Hook input exceeds byte limit' }
      else { try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { payload = { cockpit_invalid: 'Invalid hook JSON' } } }
      spoolPayload(payload, dir)
    } catch (error) {
      // Keep the observation nonblocking while making its own I/O failure visible in hook logs.
      process.stderr.write(`CLI Organizer observation unavailable (${typeof error?.code === 'string' ? error.code : 'I/O error'}).\n`)
    }
  })
  process.stdin.on('error', () => { process.stderr.write('CLI Organizer observation unavailable (stdin error).\n'); process.exitCode = 0 })
}
