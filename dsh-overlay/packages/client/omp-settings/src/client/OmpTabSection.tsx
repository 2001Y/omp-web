/**
 * omp web settings sections: one settings.section per OMP settings tab,
 * rendered from the `ompSettings/describe` catalog (schema-driven form over
 * dsh primitives; the omp host is the single source of truth for fields).
 * Usability surfaces: per-field reset-to-default, modified markers, field
 * search, collapsible groups, and a tab-level reset-all.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, DisclosureRow, IconChevronDownOutlineRegular, IconRefreshOutlineRegular, Input, Menu, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './settings.module.css'

/** The ompSettings catalog wire shape (mirrors @oh-my-pi/web's protocol file). */
interface CatalogField {
  key: string
  label: string
  description: string
  warning?: string
  type: 'boolean' | 'enum' | 'number' | 'string' | 'array'
  value: unknown
  default: unknown
  options?: Array<{ value: string; label: string; description?: string }>
  secret?: boolean
}

interface CatalogTab {
  id: string
  label: string
  groups: Array<{ label: string; fields: CatalogField[] }>
}

interface Catalog {
  tabs: CatalogTab[]
  models: Array<{
    value: string
    label: string
    provider: string
    contextWindow?: number
    maxTokens?: number
    inputPrice?: number
    outputPrice?: number
    reasoning?: boolean
    vision?: boolean
  }>
  modelRoles: Array<{ id: string; name: string; tag?: string; model?: string; thinking?: string }>
  providers: Array<{ id: string; name: string; connected: boolean; credentialCount: number }>
}

const catalogState: { promise: Promise<Catalog> | undefined } = { promise: undefined }

let rpcSeq = 0

/** One `/api` unary call (same envelope the connection layer uses). */
export async function ompApi<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `omp-settings-${rpcSeq++}`, method, payload: { args: payload } }),
  })
  const envelope = (await response.json()) as { result: { ok: boolean; value?: T; error?: { message?: string } } }
  if (!envelope.result.ok) {
    throw new Error(envelope.result.error?.message ?? `${method} failed`)
  }
  return envelope.result.value as T
}

export function loadCatalog(force = false): Promise<Catalog> {
  if (force) catalogState.promise = undefined
  catalogState.promise ??= ompApi<Catalog>('ompSettings/describe')
  return catalogState.promise
}

const BOOLEAN_OPTIONS = [
  { value: 'true', label: 'On' },
  { value: 'false', label: 'Off' },
]

function optionLabel(options: ReadonlyArray<{ value: string; label: string }>, value: unknown): string {
  if (value === undefined || value === null) return '(unset)'
  const raw = String(value)
  return options.find(option => option.value === raw)?.label ?? raw
}

/** Whether a field's current value differs from its schema default. */
function isModified(field: CatalogField): boolean {
  return JSON.stringify(field.value ?? null) !== JSON.stringify(field.default ?? null)
}

/** One settings field row with its reset-to-default affordance. */
function FieldRow({ field, onWrite }: {
  field: CatalogField
  onWrite: (key: string, value: unknown) => Promise<void>
}) {
  const [value, setValue] = useState<unknown>(field.value)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  useEffect(() => { setValue(field.value) }, [field.value])

  const write = async (next: unknown): Promise<void> => {
    setValue(next)
    setError(undefined)
    try {
      await onWrite(field.key, next)
      setSaved(true)
      setTimeout(() => { setSaved(false) }, 1200)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setValue(field.value)
    }
  }

  const menuOptions = field.type === 'boolean' ? BOOLEAN_OPTIONS : field.options ?? []
  const textValue = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  const modified = isModified(field)

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>
          {field.label}
          {modified ? <Pill className={css.modifiedPill}>modified</Pill> : null}
          {saved ? <span className={css.saved}>· saved</span> : null}
        </div>
        <div className={css.desc}>{field.description}</div>
        {field.warning !== undefined ? <div className={css.warning}>{field.warning}</div> : null}
        {error !== undefined ? <div className={css.warning}>{error}</div> : null}
      </div>
      <div className={css.rowControls}>
        {menuOptions.length > 0 ? (
          <Menu
            open={open}
            onClose={() => { setOpen(false) }}
            items={menuOptions.map(option => ({ id: option.value, label: option.label }))}
            selectedId={field.type === 'boolean' ? String(value === true) : textValue}
            onSelect={(id: string) => {
              setOpen(false)
              void write(field.type === 'boolean' ? id === 'true' : field.type === 'number' ? Number(id) : id)
            }}
            align="end"
            portal
            anchor={(
              <button
                type="button"
                className={css.selector}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => { setOpen(state => !state) }}
              >
                {field.type === 'boolean' ? (value === true ? 'On' : 'Off') : optionLabel(menuOptions, value)}
                <IconChevronDownOutlineRegular className={css.chevron} />
              </button>
            )}
          />
        ) : (
          <Input
            className={css.input ?? ""}
            type={field.secret === true ? 'password' : 'text'}
            value={textValue}
            placeholder={field.secret === true && textValue !== '' ? '(set)' : ''}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setValue(event.target.value) }}
            onBlur={() => {
              if (textValue === String(field.value)) return
              if (field.type === 'array') {
                void write(textValue.split(',').map(part => part.trim()).filter(part => part !== ''))
              } else if (field.type === 'number') {
                void write(Number(textValue))
              } else {
                void write(textValue)
              }
            }}
          />
        )}
        {modified ? (
          <button
            type="button"
            className={css.resetBtn}
            title="Restore default"
            aria-label={`Restore ${field.label} to default`}
            onClick={() => { void write(field.default) }}
          >
            <IconRefreshOutlineRegular />
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** One collapsible group of fields (DisclosureRow chrome; starts expanded). */
function GroupBlock({ group, onWrite }: {
  group: { label: string; fields: CatalogField[] }
  onWrite: (key: string, value: unknown) => Promise<void>
}) {
  const [open, setOpen] = useState(true)
  const modifiedCount = group.fields.filter(isModified).length
  const title = group.label === '' ? 'General' : group.label
  return (
    <section className={css.group}>
      <DisclosureRow
        icon={<span className={css.groupIcon} aria-hidden>{group.fields.length}</span>}
        title={modifiedCount > 0 ? `${title} · ${modifiedCount} modified` : title}
        open={open}
        expandable
        onToggle={() => { setOpen(state => !state) }}
        titleClassName={css.groupTitle}
      />
      {open ? group.fields.map(field => <FieldRow key={field.key} field={field} onWrite={onWrite} />) : null}
    </section>
  )
}

/**
 * One OMP settings tab body: field search across groups, collapsible groups,
 * and a tab-level reset-all for modified fields.
 */
export function OmpTabSection({ tab }: { tab: string }) {
  const [catalog, setCatalog] = useState<Catalog | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    loadCatalog().then(
      value => { if (alive) setCatalog(value) },
      failure => { if (alive) setError(failure instanceof Error ? failure.message : String(failure)) },
    )
    return () => { alive = false }
  }, [])

  const onWrite = async (key: string, value: unknown): Promise<void> => {
    await ompApi('ompSettings/update', { key, value })
    // Keep modified markers and reset affordances honest: invalidate the
    // cached catalog and re-render from the fresh projection.
    catalogState.promise = undefined
    void loadCatalog().then(fresh => { setCatalog(fresh) })
  }

  const target = catalog?.tabs.find(entry => entry.id === tab)
  const fieldCount = useMemo(
    () => target?.groups.reduce((sum, group) => sum + group.fields.length, 0) ?? 0,
    [target],
  )
  const modifiedFields = useMemo(
    () => target?.groups.flatMap(group => group.fields.filter(isModified)) ?? [],
    [target],
  )
  const filteredGroups = useMemo(() => {
    if (target === undefined) return []
    const needle = query.trim().toLowerCase()
    if (needle === '') return target.groups
    return target.groups
      .map(group => ({
        ...group,
        fields: group.fields.filter(field =>
          field.label.toLowerCase().includes(needle)
          || field.description.toLowerCase().includes(needle)
          || field.key.toLowerCase().includes(needle),
        ),
      }))
      .filter(group => group.fields.length > 0)
  }, [target, query])

  const resetAll = async (): Promise<void> => {
    for (const field of modifiedFields) {
      await ompApi('ompSettings/update', { key: field.key, value: field.default })
    }
    catalogState.promise = undefined
    void loadCatalog().then(value => { setCatalog(value); setQuery('') })
  }

  if (error !== undefined) return <div className={css.desc}>omp settings unavailable: {error}</div>
  if (catalog === undefined) return <div className={css.desc}>Loading…</div>
  if (target === undefined || target.groups.length === 0) {
    return <div className={css.desc}>No settings in this tab.</div>
  }

  return (
    <div>
      {fieldCount > 8 ? (
        <div className={css.toolbar}>
          <Input
            className={css.toolbarSearch ?? ""}
            type="search"
            placeholder={`Search ${fieldCount} settings…`}
            value={query}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setQuery(event.target.value) }}
          />
          {modifiedFields.length > 0 ? (
            <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular />} onClick={() => { void resetAll() }}>
              Reset {modifiedFields.length} to default{modifiedFields.length > 1 ? 's' : ''}
            </Button>
          ) : null}
        </div>
      ) : null}
      {filteredGroups.map((group, index) => (
        <GroupBlock key={group.label === '' ? `group-${index}` : group.label} group={group} onWrite={onWrite} />
      ))}
      {query !== '' && filteredGroups.length === 0 ? (
        <div className={css.desc}>No settings match “{query}”.</div>
      ) : null}
    </div>
  )
}

/** One bound section component per tab (the slot mounts `Component(props)`). */
export function sectionFor(tab: string): () => React.ReactElement {
  return function OmpSection(): React.ReactElement {
    return <OmpTabSection tab={tab} />
  }
}
