import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readGuardianArtifacts } from './codeGuardian'

it('disables an unknown Guardian version without blocking native source collection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-guardian-'))
  try {
    const skill = join(dir, 'skills', 'code-guardian'); mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '# Code Guardian (v99.0)')
    const result = readGuardianArtifacts(dir, ['/project'])
    expect(result.adapter).toMatchObject({ available: true, supported: false, version: '99.0' })
    expect(result.tasks).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
it('reports an unreadable artifact directory instead of silently presenting an empty artifact set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-guardian-'))
  try {
    const skill = join(dir, 'skills', 'code-guardian'); mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '# Code Guardian (v17.14)')
    const project = join(dir, 'project'); mkdirSync(project)
    writeFileSync(join(project, '.code-guardian-evidence'), 'not a directory')
    expect(readGuardianArtifacts(dir, [project]).events.some(event => event.kind === 'invalid')).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
