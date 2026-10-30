import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWrite, isWithinDirectory } from '../fsutil'

const files = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'cockpit-hook.cjs', 'README.md'] as const

function ensureDirectory(root: string, directory: string): void {
  if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Cockpit plugin directory cannot be a link')
  mkdirSync(directory, { recursive: true })
  if (!isWithinDirectory(root, realpathSync.native(directory))) throw new Error('Cockpit plugin directory escapes the app data directory')
}

/** Keep the optional bundle available after a portable launcher removes its extracted resources. */
export function materializeCockpitPlugin(sourceDirectory: string, dataDirectory: string): string {
  // Read the complete shipped bundle before publishing any target files.
  const bundle = files.map(file => ({ file, bytes: readFileSync(join(sourceDirectory, file)) }))
  mkdirSync(dataDirectory, { recursive: true })
  const root = realpathSync.native(dataDirectory)
  const target = join(dataDirectory, 'cockpit-plugin')
  ensureDirectory(root, target)
  for (const { file, bytes } of bundle) {
    const destination = join(target, file)
    ensureDirectory(root, dirname(destination))
    const existing = lstatSync(destination, { throwIfNoEntry: false })
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Cockpit plugin target must be a regular file without links')
    if (existing && readFileSync(destination).equals(bytes)) continue
    atomicWrite(destination, bytes)
  }
  return target
}
