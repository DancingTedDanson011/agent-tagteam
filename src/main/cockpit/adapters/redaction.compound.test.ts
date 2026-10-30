import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { rawExcerpt } from './common'

const writer = createRequire(import.meta.url)(resolve('resources/cockpit-plugin/cockpit-hook.cjs'))
const cases = [
  '{"access_token":"AUDIT_SYNTHETIC_ACCESS"}',
  '{"refresh_token":"AUDIT_SYNTHETIC_REFRESH"}',
  '{"client_secret":"AUDIT_SYNTHETIC_CLIENT"}',
  '{"DB_PASSWORD":"AUDIT_SYNTHETIC_DATABASE"}',
  '{"client\\u005fsecret":"AUDIT_SYNTHETIC_UNICODE"}',
  'ACCESS_TOKEN=AUDIT_SYNTHETIC_ENV',
  "DB_PASSWORD='AUDIT_SYNTHETIC_FIRST AUDIT_SYNTHETIC_REMAINDER'",
  JSON.stringify({ message: JSON.stringify({ refresh_token: 'AUDIT_SYNTHETIC_NESTED' }) }),
  ['sk_live_', 'AUDIT_SYNTHETIC_STRIPE_VALUE'].join(''),
  ['-----BEGIN PRIVATE KEY-----', 'AUDIT_SYNTHETIC_PEM', '-----END PRIVATE KEY-----'].join('\n')
]
for (const [index, value] of cases.entries()) it(`masks compound source and standalone plugin values (${index})`, () => {
  expect(rawExcerpt(value)).not.toContain('AUDIT_SYNTHETIC_')
  expect(JSON.stringify(writer.sanitize({ command: value }))).not.toContain('AUDIT_SYNTHETIC_')
})
