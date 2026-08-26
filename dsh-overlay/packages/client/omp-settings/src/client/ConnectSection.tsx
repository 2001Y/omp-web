/**
 * The dedicated Connect section (the TUI /provider + /login + /logout
 * surface): every known provider with its login state — connected providers
 * show their credential count with a Logout action; the rest expose the
 * terminal login flow as a copyable `/login <provider>` command (the OAuth
 * dance itself stays terminal-driven).
 */
import { useEffect, useState } from 'react'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { loadCatalog, ompApi } from './OmpTabSection.tsx'
import css from './settings.module.css'

interface ProviderAccount {
  id: string
  name: string
  connected: boolean
  credentialCount: number
}

export function ConnectSection(): React.ReactElement | null {
  const [providers, setProviders] = useState<ProviderAccount[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = (): void => {
    loadCatalog(true).then(
      catalog => { setProviders(catalog.providers) },
      failure => { setError(failure instanceof Error ? failure.message : String(failure)) },
    )
  }

  useEffect(refresh, [])

  if (error !== undefined) return <div className={css.desc}>providers unavailable: {error}</div>
  if (providers === undefined) return <div className={css.desc}>Loading…</div>
  if (providers.length === 0) {
    return <div className={css.desc}>No providers available.</div>
  }

  const connected = providers.filter(entry => entry.connected)
  const available = providers.filter(entry => !entry.connected)

  return (
    <div>
      {connected.length > 0 ? (
        <section>
          <h3 className={css.groupTitle}>Connected</h3>
          {connected.map(entry => <ConnectionRow key={entry.id} entry={entry} onLoggedOut={refresh} />)}
        </section>
      ) : null}
      {available.length > 0 ? (
        <section>
          <h3 className={css.groupTitle}>Available</h3>
          <p className={css.desc}>Run `/login &lt;provider&gt;` in a terminal to connect — the browser flow stays terminal-driven.</p>
          {available.map(entry => <AvailableRow key={entry.id} entry={entry} />)}
        </section>
      ) : null}
    </div>
  )
}

function ConnectionRow({ entry, onLoggedOut }: {
  entry: ProviderAccount
  onLoggedOut: () => void
}): React.ReactElement {
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const logout = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await ompApi('ompSettings/logoutProvider', { provider: entry.id })
      onLoggedOut()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{entry.name}</div>
        <div className={css.desc}>
          {entry.credentialCount} {entry.credentialCount === 1 ? 'credential' : 'credentials'} stored
        </div>
        {error !== undefined ? <div className={css.warning}>{error}</div> : null}
      </div>
      <div className={css.rowControls}>
        <Pill>Connected</Pill>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void logout() }}>
          {busy ? 'Logging out…' : 'Logout'}
        </Button>
      </div>
    </div>
  )
}

function AvailableRow({ entry }: { entry: ProviderAccount }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const copyLogin = async (): Promise<void> => {
    setError(undefined)
    try {
      await navigator.clipboard.writeText(`/login ${entry.id}`)
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1200)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{entry.name}</div>
        <div className={css.desc}>Not connected</div>
        {error !== undefined ? <div className={css.warning}>{error}</div> : null}
      </div>
      <div className={css.rowControls}>
        <Button variant="ghost" size="sm" onClick={() => { void copyLogin() }}>
          {copied ? 'Copied' : 'Copy login command'}
        </Button>
      </div>
    </div>
  )
}
