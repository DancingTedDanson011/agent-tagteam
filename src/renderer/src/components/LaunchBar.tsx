// INTENTIONAL-UNTESTED: presentational component without a unit harness (no DOM test dependency); the
// folder rules are unit-tested in shared/folder.ts, the bar itself by the selftest and Playwright.
import { useState } from 'react'
import { useT } from '../i18n'
import { Icon } from './Icon'

/** Bottom bar: open a PowerShell or Command Prompt tile, in a pasted folder or the home folder. */
export function LaunchBar({ onStarted }: { onStarted: (id: string) => void }) {
  const t = useT()
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const launch = async (provider: 'pwsh' | 'cmd') => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.organizer.startShell(provider, folder)
      if (r.ok) {
        setFolder('')
        onStarted(r.id)
      } else setError(r.error === 'bad-cwd' ? t.launchBadFolder(r.detail ?? folder) : t.agentStartFailed(r.detail ?? r.error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="launch-bar">
      <button type="button" className="button is-quiet is-compact" disabled={busy} onClick={() => void launch('pwsh')} title={t.launchPwshTitle}>
        <Icon name="agent" />
        <span>PowerShell</span>
      </button>
      <button type="button" className="button is-quiet is-compact" disabled={busy} onClick={() => void launch('cmd')} title={t.launchCmdTitle}>
        <Icon name="agent" />
        <span>{t.launchCmd}</span>
      </button>
      <input
        className="launch-folder"
        value={folder}
        placeholder={t.launchFolderPlaceholder}
        aria-label={t.launchFolderLabel}
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        onChange={(e) => setFolder(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void launch('pwsh')
        }}
      />
      {error && (
        <span className="launch-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
