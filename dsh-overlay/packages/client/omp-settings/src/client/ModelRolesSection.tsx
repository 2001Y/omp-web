/**
 * The dedicated Model Roles section (the TUI /model surface): one row per
 * known role (tag pill, current model, thinking selector) and an expandable
 * model browser — provider-grouped, searchable, with the TUI's metadata
 * columns (context, max output, per-M cost, capability badges).
 */
import { useEffect, useMemo, useState } from 'react'
import { IconChevronDownOutlineRegular, Input, Menu, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { loadCatalog, ompApi } from './OmpTabSection.tsx'
import css from './settings.module.css'

interface RoleRow {
  id: string
  name: string
  tag?: string
  model?: string
  thinking?: string
}

interface ModelOption {
  value: string
  label: string
  provider: string
  contextWindow?: number
  maxTokens?: number
  inputPrice?: number
  outputPrice?: number
  reasoning?: boolean
  vision?: boolean
}

const THINKING_CHOICES = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function formatTokens(value: number | undefined): string {
  if (value === undefined || value <= 0) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

function formatPrice(value: number | undefined): string {
  if (value === undefined || value <= 0) return '0'
  return value >= 100 ? String(Math.round(value)) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
}

function modelMeta(model: ModelOption): string {
  const parts: string[] = []
  const context = formatTokens(model.contextWindow)
  if (context !== '') parts.push(`${context} ctx`)
  const output = formatTokens(model.maxTokens)
  if (output !== '') parts.push(`${output} out`)
  if (model.inputPrice !== undefined || model.outputPrice !== undefined) {
    parts.push(`$${formatPrice(model.inputPrice)}/${formatPrice(model.outputPrice)}`)
  }
  return parts.join(' · ')
}

export function ModelRolesSection(): React.ReactElement | null {
  const [roles, setRoles] = useState<RoleRow[] | undefined>(undefined)
  const [models, setModels] = useState<ModelOption[]>([])
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    loadCatalog().then(
      catalog => {
        if (!alive) return
        setRoles(catalog.modelRoles)
        setModels(catalog.models)
      },
      failure => { if (alive) setError(failure instanceof Error ? failure.message : String(failure)) },
    )
    return () => { alive = false }
  }, [])

  if (error !== undefined) return <div className={css.desc}>model roles unavailable: {error}</div>
  if (roles === undefined) return <div className={css.desc}>Loading…</div>
  if (roles.length === 0) return <div className={css.desc}>No model roles configured.</div>

  return (
    <div>
      <p className={css.desc}>Assign a model and thinking depth to every role; unset roles inherit the default.</p>
      {roles.map(role => <RoleRowView key={role.id} role={role} models={models} />)}
    </div>
  )
}

function RoleRowView({ role, models }: { role: RoleRow; models: ReadonlyArray<ModelOption> }): React.ReactElement {
  const [current, setCurrent] = useState<{ model: string | undefined; thinking: string | undefined }>({
    model: role.model,
    thinking: role.thinking,
  })
  const [browseOpen, setBrowseOpen] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => { setCurrent({ model: role.model, thinking: role.thinking }) }, [role.model, role.thinking])

  const assign = async (model: string, thinking: string | undefined): Promise<void> => {
    setError(undefined)
    try {
      // model === '' clears the role; thinking only rides an assignment.
      await ompApi('ompSettings/setModelRole', {
        role: role.id,
        ...(model === '' ? {} : { model, ...(thinking !== undefined && thinking !== '' ? { thinking } : {}) }),
      })
      setCurrent({ model: model === '' ? undefined : model, thinking: model === '' ? undefined : thinking })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  return (
    <div className={css.roleBlock}>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>
            {role.tag !== undefined ? <Pill className={css.tag}>{role.tag}</Pill> : null}
            {role.name}
          </div>
          <div className={css.desc}>
            {current.model === undefined
              ? 'Unset — inherits the default role'
              : `${current.model}${current.thinking !== undefined ? ` · ${current.thinking}` : ''}`}
          </div>
          {error !== undefined ? <div className={css.warning}>{error}</div> : null}
        </div>
        <ThinkingMenu
          value={current.thinking}
          disabled={current.model === undefined}
          onSelect={thinking => { void assign(current.model ?? '', thinking === '' ? undefined : thinking) }}
        />
        <button
          type="button"
          className={css.selector}
          aria-expanded={browseOpen}
          onClick={() => { setBrowseOpen(state => !state) }}
        >
          {browseOpen ? 'Close' : 'Browse'}
        </button>
      </div>
      {browseOpen ? <ModelBrowser models={models} selected={current.model} onPick={model => { void assign(model, current.thinking) }} /> : null}
    </div>
  )
}

function ThinkingMenu({ value, disabled, onSelect }: {
  value: string | undefined
  disabled: boolean
  onSelect: (thinking: string) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={THINKING_CHOICES.map(choice => ({ id: choice, label: choice === '' ? 'default' : choice }))}
      selectedId={value ?? ''}
      onSelect={(id: string) => { setOpen(false); onSelect(id) }}
      align="end"
      portal
      anchor={(
        <button
          type="button"
          className={css.selector}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { setOpen(state => !state) }}
        >
          {value === undefined || value === '' ? 'thinking' : value}
          <IconChevronDownOutlineRegular className={css.chevron} />
        </button>
      )}
    />
  )
}

function ModelBrowser({ models, selected, onPick }: {
  models: ReadonlyArray<ModelOption>
  selected: string | undefined
  onPick: (model: string) => void
}): React.ReactElement {
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matched = models.filter(model =>
      needle === '' || model.label.toLowerCase().includes(needle) || model.value.toLowerCase().includes(needle),
    )
    const byProvider = new Map<string, ModelOption[]>()
    for (const model of matched) {
      const bucket = byProvider.get(model.provider) ?? []
      bucket.push(model)
      byProvider.set(model.provider, bucket)
    }
    return [...byProvider.entries()]
  }, [models, query])

  return (
    <div className={css.browser}>
      <Input
        className={css.browserSearch ?? ""}
        type="search"
        placeholder="Search models…"
        value={query}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setQuery(event.target.value) }}
      />
      <div className={css.browserList}>
        {groups.map(([provider, entries]) => (
          <section key={provider}>
            <h4 className={css.groupTitle}>{provider}</h4>
            {entries.map(model => (
              <button
                type="button"
                key={model.value}
                className={model.value === selected ? css.modelRowSelected : css.modelRow}
                onClick={() => { onPick(model.value) }}
              >
                <span className={css.modelName}>
                  {model.label}
                  {model.reasoning === true ? <Pill className={css.tag}>reasoning</Pill> : null}
                  {model.vision === true ? <Pill className={css.tag}>vision</Pill> : null}
                </span>
                <span className={css.modelMeta}>{modelMeta(model)}</span>
              </button>
            ))}
          </section>
        ))}
        {groups.length === 0 ? <div className={css.desc}>No models match.</div> : null}
      </div>
    </div>
  )
}
