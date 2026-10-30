import { expect, it } from 'vitest'
import { invalidEvent } from './common'

it('masks quoted credential values even in malformed JSON excerpts', () => {
  const event = invalidEvent('hook', 'bad JSON', '{"token":"private-value", "password": "private-password", "access_token":"private-access"')
  expect(event.raw).not.toContain('private-value')
  expect(event.raw).not.toContain('private-password')
  expect(event.raw).not.toContain('private-access')
})
