import { expect, it } from 'vitest'
import { redact } from './mcp'

const cases: [string, string][] = [
  ['access-token JSON', '{"access_token":"AUDIT_SYNTHETIC_ACCESS"}'],
  ['refresh-token JSON', '{"refresh_token":"AUDIT_SYNTHETIC_REFRESH"}'],
  ['client-secret JSON', '{"client_secret":"AUDIT_SYNTHETIC_CLIENT"}'],
  ['database-password JSON', '{"DB_PASSWORD":"AUDIT_SYNTHETIC_DATABASE"}'],
  ['Unicode compound JSON key', '{"access\\u005ftoken":"AUDIT_SYNTHETIC_UNICODE"}'],
  ['quoted access-token ENV', 'ACCESS_TOKEN="AUDIT_SYNTHETIC_ENV"'],
  ['compound quoted ENV with spaces', "export REFRESH_TOKEN='AUDIT_SYNTHETIC_FIRST AUDIT_SYNTHETIC_REMAINDER'"],
  ['unquoted database ENV with spaces', 'DB_PASSWORD=AUDIT_SYNTHETIC_FIRST AUDIT_SYNTHETIC_REMAINDER\npublic next line'],
  ['client-secret ENV', 'CLIENT_SECRET=AUDIT_SYNTHETIC_ENV_CLIENT'],
  ['PowerShell ENV', "$env:DB_PASSWORD='AUDIT_SYNTHETIC_POWERSHELL'"],
  ['truncated quoted compound JSON', '{"client_secret":"AUDIT_SYNTHETIC_FIRST AUDIT_SYNTHETIC_TRUNCATED\\'],
  ['truncated quoted compound ENV', "DB_PASSWORD='AUDIT_SYNTHETIC_FIRST AUDIT_SYNTHETIC_TRUNCATED\\"],
  ['JSON-encoded credential JSON', JSON.stringify({ message: JSON.stringify({ refresh_token: 'AUDIT_SYNTHETIC_NESTED' }) })],
  ['cookie header remainder', 'Cookie: session=AUDIT_SYNTHETIC_COOKIE; other=AUDIT_SYNTHETIC_OTHER']
]
for (const [name, value] of cases) it(`masks compound credentials: ${name}`, () => {
  const result = redact(value)
  expect(result).not.toContain('AUDIT_SYNTHETIC_')
  expect(result).toContain('****')
})
it('keeps unrelated values and ordinary project paths unchanged', () => {
  for (const value of ['PUBLIC_SETTING=visible', '{"ordinary":"visible"}', 'C:\\workspace\\client_secret_code']) expect(redact(value)).toBe(value)
})
