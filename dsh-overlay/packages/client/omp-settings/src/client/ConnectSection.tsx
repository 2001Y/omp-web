/**
 * The dedicated Connect section (the TUI /provider + /login + /logout
 * surface): every known provider with its login state. Connected providers
 * show their credential count with a Logout action; the rest sign in right
 * here — the host runs the provider's own OAuth flow (ompSettings/login*)
 * and this panel carries the browser half: open the sign-in page, enter
 * the device code it shows, answer a prompt when the flow asks for one
 * (an authorization code, an API key). No terminal involved.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { loadCatalog, ompApi } from './OmpTabSection.tsx'
import css from './settings.module.css'

interface ProviderAccount {
  id: string
  name: string
  connected: boolean
  credentialCount: number
}

interface LoginAttempt {
  attemptId: string
  provider: string
  state: 'pending' | 'done' | 'error'
  auth?: { url: string; instructions?: string }
  progress?: string
  prompt?: { message: string; secret?: boolean }
  identity?: string
  error?: string
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
          <p className={css.desc}>Sign in here — the provider&rsquo;s page opens in your browser, and this panel finishes the rest.</p>
          {available.map(entry => <AvailableRow key={entry.id} entry={entry} onLoggedIn={refresh} />)}
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

function AvailableRow({ entry, onLoggedIn }: {
  entry: ProviderAccount
  onLoggedIn: () => void
}): React.ReactElement {
  const [attempt, setAttempt] = useState<LoginAttempt | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const settledRef = useRef(false)

  const attemptId = attempt?.attemptId
  const attemptState = attempt?.state

  // Poll the attempt while it is pending; landing on done hands over to the
  // parent refresh exactly once (the row then remounts under Connected).
  useEffect(() => {
    if (attemptId === undefined || attemptState !== 'pending') return
    let cancelled = false
    const timer = setInterval(() => {
      ompApi<LoginAttempt>('ompSettings/loginStatus', { attemptId }).then(
        next => {
          if (cancelled) return
          setAttempt(next)
          if (next.state === 'done' && !settledRef.current) {
            settledRef.current = true
            onLoggedIn()
          }
        },
        () => {},
      )
    }, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [attemptId, attemptState, onLoggedIn])

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    settledRef.current = false
    try {
      const next = await ompApi<LoginAttempt>('ompSettings/loginStart', { provider: entry.id })
      setAttempt(next)
      if (next.state === 'done') {
        settledRef.current = true
        onLoggedIn()
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (attempt === undefined) return
    try {
      await ompApi('ompSettings/loginCancel', { attemptId: attempt.attemptId })
    } catch {
      // The panel closes either way; a failed cancel leaves a server-side
      // attempt that expires on its own.
    }
    setAttempt(undefined)
  }

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{entry.name}</div>
        <div className={css.desc}>Not connected</div>
        {error !== undefined ? <div className={css.warning}>{error}</div> : null}
        {attempt !== undefined ? (
          <LoginAttemptPanel
            attempt={attempt}
            onCancel={() => { void cancel() }}
            onRetry={() => { setAttempt(undefined) }}
          />
        ) : null}
      </div>
      <div className={css.rowControls}>
        {attempt === undefined ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void start() }}>
            {busy ? 'Starting…' : 'Login'}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function LoginAttemptPanel({ attempt, onCancel, onRetry }: {
  attempt: LoginAttempt
  onCancel: () => void
  onRetry: () => void
}): React.ReactElement {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | undefined>(undefined)

  if (attempt.state === 'error') {
    return (
      <div className={css.loginBox}>
        <div className={css.warning}>{attempt.error ?? 'Login failed'}</div>
        <div className={css.actionBar}>
          <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
        </div>
      </div>
    )
  }

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setSubmitError(undefined)
    try {
      await ompApi('ompSettings/loginSubmitCode', { attemptId: attempt.attemptId, code })
      setCode('')
    } catch (failure) {
      setSubmitError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={css.loginBox}>
      <div className={css.desc}>{attempt.progress ?? 'Waiting for sign-in…'}</div>
      {attempt.auth !== undefined ? (
        <>
          {attempt.auth.instructions !== undefined ? (
            <div className={css.loginCode}>{attempt.auth.instructions}</div>
          ) : null}
          <div className={css.actionBar}>
            <Button
              size="sm"
              onClick={() => { window.open(attempt.auth?.url, '_blank', 'noopener') }}
            >
              Open sign-in page
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          </div>
        </>
      ) : (
        <div className={css.actionBar}>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      )}
      {attempt.prompt !== undefined ? (
        <>
          <div className={css.desc}>{attempt.prompt.message}</div>
          <div className={css.actionBar}>
            <Input
              className={css.input ?? ''}
              type={attempt.prompt.secret ? 'password' : 'text'}
              value={code}
              aria-label={attempt.prompt.message}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setCode(event.target.value) }}
              onKeyDown={(event: React.KeyboardEvent) => {
                if (event.key === 'Enter') { void submit() }
              }}
            />
            <Button size="sm" disabled={submitting} onClick={() => { void submit() }}>
              {submitting ? 'Sending…' : 'Submit'}
            </Button>
          </div>
          {submitError !== undefined ? <div className={css.warning}>{submitError}</div> : null}
        </>
      ) : null}
    </div>
  )
}
