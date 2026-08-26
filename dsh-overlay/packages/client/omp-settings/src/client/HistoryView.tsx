/**
 * The History view (TUI `/tree` parity): a canvas-drawn node tree on the left
 * — dots plus curved connectors, where only branch points add depth and
 * hidden intermediates keep their ancestor's column (the TUI's gutter
 * semantics) — the TUI's five filter modes and search, keyboard navigation,
 * and a detail pane with rewind (summarize-and-switch), fork, and entry
 * labels. All chrome text localizes through the `omp.history` dictionaries.
 *
 * The canvas is viewport-sized and repaints on scroll (Git-graph style): only
 * the visible row window is drawn each frame, connectors entering from above
 * clamp to the viewport top, and the last visible row extends its child lane
 * off-screen. The view owns its scrolling (data-conversation-composer-overlay
 * opts it into the full-height view area).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  Button,
  IconBranchOutline16,
  IconChevronDownOutline14,
  Input,
  Menu,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { ompApi } from './OmpTabSection.tsx'
import type { HistoryKey, HistoryT } from './locales.ts'
import css from './settings.module.css'

interface HistoryNode {
  id: string
  parentId: string | null
  kind: string
  text: string
  label?: string
  timestamp: number
  onCurrentPath: boolean
  currentLeaf: boolean
  bookkeeping: boolean
  toolCallsOnly: boolean
  errorOrAborted: boolean
}

interface InputActionsFace {
  setDraft: (text: string) => void
}

/** Kit-provided chat-store write seat (shares the chat view's store handle). */
interface ViewActionsFace {
  setView: (view: string) => void
}


type FilterMode = 'default' | 'noTools' | 'userOnly' | 'labeledOnly' | 'all'

const FILTER_MODES: Array<{ id: FilterMode; key: HistoryKey }> = [
  { id: 'default', key: 'filter.default' },
  { id: 'noTools', key: 'filter.noTools' },
  { id: 'userOnly', key: 'filter.userOnly' },
  { id: 'labeledOnly', key: 'filter.labeledOnly' },
  { id: 'all', key: 'filter.all' },
]

const ROLE_KEY: Record<string, HistoryKey> = {
  user: 'role.user',
  assistant: 'role.assistant',
  developer: 'role.developer',
}

const KIND_KEY: Record<string, HistoryKey> = {
  toolResult: 'role.tool',
  bashExecution: 'kind.bash',
  compaction: 'kind.compaction',
  branchSummary: 'kind.branchSummary',
  modelChange: 'kind.model',
  thinkingLevelChange: 'kind.thinking',
  serviceTierChange: 'kind.serviceTier',
  titleChange: 'kind.title',
  modeChange: 'kind.mode',
  credentialPin: 'kind.credentialPin',
  ttsrInjection: 'kind.ttsrInjection',
  resetBoundary: 'kind.resetBoundary',
  sessionInit: 'kind.sessionInit',
  custom: 'kind.custom',
  label: 'kind.label',
}

/** Tree row geometry (shared by the DOM rows and the canvas overlay). */
const ROW_H = 32
const LEVEL_W = 18
const DOT_X0 = 16
const DOT_R = 3
const TEXT_PAD = 12
const PAD_TOP = 6
const dotX = (depth: number): number => DOT_X0 + depth * LEVEL_W
const rowY = (index: number): number => PAD_TOP + index * ROW_H + ROW_H / 2

interface FlatRow {
  node: HistoryNode
  /** TUI indent: only branch points (multi-child parents) add a level. */
  depth: number
  /** Index of the nearest VISIBLE strict ancestor (connector origin). */
  ancIndex?: number
  /** Lane x where this row's children sit; undefined when childless. */
  childLaneX?: number
}

interface TreeModel {
  rows: FlatRow[]
  byId: Map<string, HistoryNode>
}

/**
 * Flatten the entry forest in TUI order: the branch containing the active
 * leaf sorts first at every level, and a parent with multiple children
 * indents its subtree one level while linear chains stay aligned.
 */
function buildTreeModel(nodes: HistoryNode[]): TreeModel {
  const byId = new Map(nodes.map(node => [node.id, node] as const))
  const childrenOf = new Map<string | null, HistoryNode[]>()
  for (const node of nodes) {
    const key = node.parentId !== null && byId.has(node.parentId) ? node.parentId : null
    const bucket = childrenOf.get(key) ?? []
    bucket.push(node)
    childrenOf.set(key, bucket)
  }
  const leafId = nodes.find(node => node.currentLeaf)?.id ?? null

  // containsActive per node, computed iteratively (post-order over the
  // pre-order list) so deep linear chains cannot overflow the stack.
  const preOrder: HistoryNode[] = []
  const walkStack: HistoryNode[] = [...(childrenOf.get(null) ?? [])]
  while (walkStack.length > 0) {
    const node = walkStack.pop() as HistoryNode
    preOrder.push(node)
    const kids = childrenOf.get(node.id) ?? []
    for (const kid of kids) walkStack.push(kid)
  }
  const contains = new Map<string, boolean>()
  for (let i = preOrder.length - 1; i >= 0; i--) {
    const node = preOrder[i] as HistoryNode
    let has = node.id === leafId
    for (const kid of childrenOf.get(node.id) ?? []) {
      if (contains.get(kid.id) === true) has = true
    }
    contains.set(node.id, has)
  }
  const ordered = (list: HistoryNode[]): HistoryNode[] => [
    ...list.filter(kid => contains.get(kid.id) === true),
    ...list.filter(kid => contains.get(kid.id) !== true),
  ]

  const rows: FlatRow[] = []
  const frames: Array<{ node: HistoryNode; depth: number }> = ordered(childrenOf.get(null) ?? [])
    .map(node => ({ node, depth: 0 }))
    .reverse()
  while (frames.length > 0) {
    const frame = frames.pop() as { node: HistoryNode; depth: number }
    const row: FlatRow = { node: frame.node, depth: frame.depth }
    rows.push(row)
    const kids = ordered(childrenOf.get(frame.node.id) ?? [])
    const childDepth = kids.length > 1 ? frame.depth + 1 : frame.depth
    if (kids.length > 0) row.childLaneX = dotX(childDepth)
    for (let i = kids.length - 1; i >= 0; i--) {
      frames.push({ node: kids[i] as HistoryNode, depth: childDepth })
    }
  }
  return { rows, byId }
}

/** The TUI's per-mode visibility rules (tool-call-only rows hide everywhere). */
function passesFilter(node: HistoryNode, mode: FilterMode): boolean {
  if (node.kind === 'assistant' && !node.currentLeaf && node.toolCallsOnly && !node.errorOrAborted) {
    return false
  }
  switch (mode) {
    case 'userOnly':
      return node.kind === 'user'
    case 'noTools':
      return !node.bookkeeping && node.kind !== 'toolResult'
    case 'labeledOnly':
      return node.label !== undefined
    case 'all':
      return true
    default:
      return !node.bookkeeping
  }
}

function matchesSearch(node: HistoryNode, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = `${node.label ?? ''} ${node.kind} ${node.text}`.toLowerCase()
  return tokens.every(token => haystack.includes(token))
}

/** Row/detail display text in the TUI's bracket vocabulary (localized labels). */
function displayText(node: HistoryNode, t: HistoryT): string {
  const kindKey = KIND_KEY[node.kind]
  switch (node.kind) {
    case 'user':
    case 'developer':
      return node.text
    case 'assistant':
      if (node.text !== '') return node.text
      return node.errorOrAborted ? t('state.aborted') : t('state.noContent')
    case 'toolResult':
    case 'customMessage':
      return `[${node.text}]`
    case 'bashExecution':
      return `[${t('kind.bash')}: ${node.text}]`
    case 'compaction':
      return `[${t('kind.compaction')}: ${t('kind.compactionTokens', { count: node.text })}]`
    case 'serviceTierChange':
      return node.text === '' ? `[${t('kind.serviceTier')}: ${t('state.default')}]` : `[${t('kind.serviceTier')}: ${node.text}]`
    default:
      return kindKey !== undefined ? `[${t(kindKey)}: ${node.text}]` : node.text
  }
}

/** The detail pill's kind label (roles and bracket categories alike). */
function kindLabel(node: HistoryNode, t: HistoryT): string {
  const roleKey = ROLE_KEY[node.kind]
  if (roleKey !== undefined) return t(roleKey)
  const kindKey = KIND_KEY[node.kind]
  return kindKey !== undefined ? t(kindKey) : node.kind
}

/**
 * The History view body: canvas tree selector on the left, detail + action
 * bar on the right.
 */
export function HistoryView({ sessionId, t, inputActions, actions, refreshSessions, openSession }: {
  sessionId: SessionId
  t: HistoryT
  inputActions?: InputActionsFace
  actions?: ViewActionsFace
  refreshSessions?: () => void
  openSession?: (id: SessionId) => Promise<void>
}): React.ReactElement | null {
  const [nodes, setNodes] = useState<HistoryNode[] | undefined>(undefined)
  const [branchSummariesEnabled, setBranchSummariesEnabled] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [filterMode, setFilterMode] = useState<FilterMode>('default')
  const [filterOpen, setFilterOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [summarizeChoice, setSummarizeChoice] = useState<{ entryId: string } | undefined>(undefined)
  const [customPrompt, setCustomPrompt] = useState<{ entryId: string; value: string } | undefined>(undefined)
  const [labelEdit, setLabelEdit] = useState<{ entryId: string; value: string } | undefined>(undefined)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  const refresh = (keepId?: string): void => {
    void ompApi<{ nodes: HistoryNode[]; branchSummariesEnabled: boolean }>('ompHistory/tree', { sessionId }).then(
      value => {
        setNodes(value.nodes)
        setBranchSummariesEnabled(value.branchSummariesEnabled)
        const leaf = value.nodes.find(node => node.currentLeaf)?.id
        setSelectedId(current => {
          // TUI opens on the active leaf; a kept selection survives refresh.
          const target = keepId ?? (current !== undefined && value.nodes.some(node => node.id === current) ? current : leaf)
          return target !== undefined && value.nodes.some(node => node.id === target) ? target : leaf
        })
      },
      failure => { setError(failure instanceof Error ? failure.message : String(failure)) },
    )
  }

  useEffect(() => {
    rowRefs.current.clear()
    setNodes(undefined)
    setError(undefined)
    setSelectedId(undefined)
    setQuery('')
    setNotice(undefined)
    setSummarizeChoice(undefined)
    setCustomPrompt(undefined)
    setLabelEdit(undefined)
    refresh()
  }, [sessionId])

  const model = useMemo(() => (nodes === undefined ? { rows: [], byId: new Map<string, HistoryNode>() } : buildTreeModel(nodes)), [nodes])

  const visibleRows = useMemo(() => {
    const visible = model.rows
      .filter(row => passesFilter(row.node, filterMode) && matchesSearch(row.node, query))
    const indexById = new Map(visible.map((row, index) => [row.node.id, index] as const))
    return visible.map(row => {
      // Connector origin: the nearest visible strict ancestor, so a row
      // under hidden intermediates still joins its ancestor's column.
      let ancIndex: number | undefined
      let cursor: string | null = row.node.parentId
      while (cursor !== null) {
        const hit = indexById.get(cursor)
        if (hit !== undefined) {
          ancIndex = hit
          break
        }
        const parent = model.byId.get(cursor)
        cursor = parent !== undefined ? parent.parentId : null
      }
      return { node: row.node, depth: row.depth, ancIndex, childLaneX: row.childLaneX }
    })
  }, [model, filterMode, query])

  const visibleIndexById = useMemo(
    () => new Map(visibleRows.map((row, index) => [row.node.id, index] as const)),
    [visibleRows],
  )

  // Re-clamp the selection to a visible row when the filter or search hides
  // it (TUI #findNearestVisibleIndex: walk ancestors, else last row).
  useEffect(() => {
    setSelectedId(current => {
      if (current === undefined || visibleIndexById.has(current)) return current
      let cursor: string | null = model.byId.get(current)?.parentId ?? null
      while (cursor !== null) {
        if (visibleIndexById.has(cursor)) return cursor
        const parent = model.byId.get(cursor)
        cursor = parent !== undefined ? parent.parentId : null
      }
      return visibleRows.at(-1)?.node.id
    })
  }, [visibleIndexById, model, visibleRows])

  // Keep the selected row in view (keyboard navigation parity).
  useEffect(() => {
    if (selectedId === undefined) return
    rowRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  /**
   * Viewport-sized repaint: only the visible row window is drawn, offset by
   * scrollTop. Connectors whose ancestor sits above the viewport clamp to the
   * top edge (the lane "enters" the view like a Git graph); the last visible
   * row extends its child lane off the bottom when more rows follow.
   */
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const scroll = scrollRef.current
    if (canvas === null || scroll === null || visibleRows.length === 0) return
    const cssW = scroll.clientWidth
    const cssH = scroll.clientHeight
    if (cssW === 0 || cssH === 0) return
    const dpr = window.devicePixelRatio ?? 1
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    const styles = getComputedStyle(canvas)
    // A custom property can compute to an unresolved var() reference, which
    // canvas silently refuses (the assignment is ignored and the previous
    // color sticks). Round-trip every candidate through strokeStyle so only
    // values the canvas can actually parse win; the last resort keeps the
    // tree readable in both themes.
    const colorOf = (names: readonly string[], fallback: string): string => {
      for (const name of names) {
        const value = styles.getPropertyValue(name).trim()
        if (value === '') continue
        ctx.strokeStyle = '#000'
        ctx.strokeStyle = value
        if (ctx.strokeStyle !== '#000000') return value
      }
      return fallback
    }
    const lineColor = colorOf(
      ['--dsw-alias-border-l3', '--dsw-alias-border-l2'],
      'rgba(128, 128, 128, 0.55)',
    )
    // The trajectory's brand blue reads as the accent in BOTH themes (the
    // plain brand-primary is near-black in the light theme).
    const accentColor = colorOf(
      ['--dsw-alias-brand-primary-new-colorprimary-new-color', '--dsw-alias-state-business-primary'],
      '#4d6bfe',
    )
    const dotColor = colorOf(
      ['--dsw-alias-label-dimmed', '--dsw-alias-label-tertiary'],
      'rgba(178, 183, 192, 0.9)',
    )

    const scrollTop = scroll.scrollTop
    // 1px strokes need half-pixel centers; filled dots do not.
    const yOf = (index: number): number => rowY(index) - scrollTop + 0.5
    const laneX = (depth: number): number => dotX(depth) + 0.5
    const first = Math.max(0, Math.floor((scrollTop - PAD_TOP) / ROW_H))
    const last = Math.min(visibleRows.length, Math.ceil((scrollTop + cssH - PAD_TOP) / ROW_H) + 1)

    ctx.lineWidth = 1
    ctx.strokeStyle = lineColor
    for (let i = first; i < last; i++) {
      const row = visibleRows[i] as FlatRow
      const y2 = yOf(i)
      if (row.ancIndex !== undefined && row.ancIndex < first) {
        // The ancestor left the viewport: its lane enters from the top edge.
        const anc = visibleRows[row.ancIndex] as FlatRow
        const x1 = laneX(anc.depth)
        const x2 = laneX(row.depth)
        const k = Math.min(16, y2 / 2)
        ctx.beginPath()
        ctx.moveTo(x1, 0)
        ctx.bezierCurveTo(x1, Math.min(k, 8), x2, y2 - k, x2, y2)
        ctx.stroke()
      }
    }
    for (let i = first; i < last; i++) {
      const row = visibleRows[i] as FlatRow
      const y2 = yOf(i)
      if (row.ancIndex !== undefined && row.ancIndex >= first) {
        const anc = visibleRows[row.ancIndex] as FlatRow
        const x1 = laneX(anc.depth)
        const x2 = laneX(row.depth)
        const y1 = yOf(row.ancIndex)
        ctx.beginPath()
        if (x1 === x2) {
          // Linear continuation: one straight segment down the shared column.
          ctx.moveTo(x1, y1)
          ctx.lineTo(x1, y2)
        } else {
          // Branch child: a curved elbow from the ancestor's dot into ours.
          const k = Math.min(16, (y2 - y1) / 2)
          ctx.moveTo(x1, y1)
          ctx.bezierCurveTo(x1, y1 + k, x2, y2 - k, x2, y2)
        }
        ctx.stroke()
      }
    }
    // Off-screen continuation: rows follow the last visible one.
    if (last < visibleRows.length && last - 1 >= 0) {
      const edge = visibleRows[last - 1] as FlatRow
      if (edge.childLaneX !== undefined) {
        const lane = edge.childLaneX + 0.5
        ctx.beginPath()
        ctx.moveTo(lane, yOf(last - 1))
        ctx.lineTo(lane, cssH)
        ctx.stroke()
      }
    }

    for (let i = first; i < last; i++) {
      const row = visibleRows[i] as FlatRow
      const x = dotX(row.depth)
      const y = yOf(i)
      if (row.node.currentLeaf) {
        ctx.beginPath()
        ctx.arc(x, y, DOT_R + 2.5, 0, Math.PI * 2)
        ctx.strokeStyle = accentColor
        ctx.stroke()
        ctx.strokeStyle = lineColor
      }
      ctx.beginPath()
      ctx.arc(x, y, DOT_R, 0, Math.PI * 2)
      ctx.fillStyle = row.node.onCurrentPath ? accentColor : dotColor
      ctx.fill()
    }
  }, [visibleRows])

  useLayoutEffect(() => {
    draw()
    // Post-layout safety: the first paint can precede final layout.
    const raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf) }
  }, [draw])

  useEffect(() => {
    const scroll = scrollRef.current
    if (scroll === null) return
    let raf = 0
    const repaint = (): void => {
      if (raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        draw()
      })
    }
    scroll.addEventListener('scroll', repaint, { passive: true })
    const observer = new ResizeObserver(repaint)
    observer.observe(scroll)
    // Theme flips swap the --dsw-* token values the canvas reads per draw.
    const mutations = new MutationObserver(repaint)
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => {
      scroll.removeEventListener('scroll', repaint)
      observer.disconnect()
      mutations.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [draw])

  const selected = nodes?.find(node => node.id === selectedId)

  const rewind = async (options?: { summarize?: boolean; customInstructions?: string }): Promise<void> => {
    if (selected === undefined || busy !== undefined) return
    setSummarizeChoice(undefined)
    setCustomPrompt(undefined)
    // TUI: selecting the current leaf is a no-op ("Already at this point").
    if (selected.currentLeaf) {
      setNotice(t('notice.already'))
      return
    }
    // TUI asks about branch summaries before every navigation that crosses a
    // branch (Shift+Enter pre-answers Summarize; the buttons pass it here).
    if (branchSummariesEnabled && options?.summarize === undefined) {
      setSummarizeChoice({ entryId: selected.id })
      return
    }
    setBusy('rewind')
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await ompApi<{ editorText?: string; aborted?: boolean }>('ompHistory/navigate', {
        sessionId,
        entryId: selected.id,
        ...(options?.summarize === true ? { summarize: true } : {}),
        ...(typeof options?.customInstructions === 'string' && options.customInstructions !== ''
          ? { customInstructions: options.customInstructions }
          : {}),
      })
      if (result.aborted === true) {
        setNotice(t('notice.summaryAborted'))
      } else if (result.editorText !== undefined && result.editorText !== '' && inputActions !== undefined) {
        // TUI /tree parity: a rewound user message's text lands in the composer.
        inputActions.setDraft(result.editorText)
        setNotice(t('notice.rewoundEditor'))
      } else {
        setNotice(t('notice.rewound'))
      }
      refresh(selected.id)
      // Land the user back on the conversation at the rewound point.
      actions?.setView('chat')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const forkHere = async (): Promise<void> => {
    if (selected === undefined || busy !== undefined) return
    setBusy('fork')
    setError(undefined)
    setNotice(undefined)
    try {
      const forked = await ompApi<{ sessionId: string }>('ompHistory/forkAt', { sessionId, entryId: selected.id })
      setNotice(t('notice.forked'))
      // Pull the list twice (a settle retry) so the child row is certain to
      // be in the sidebar, then land the conversation on the child session.
      // The open retries against fresh list pulls until the child is known,
      // then lands the conversation on it; a settle refresh follows for the
      // title.
      await openSession?.(forked.sessionId as SessionId)
      refreshSessions?.()
      window.setTimeout(() => { refreshSessions?.() }, 800)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const saveLabel = async (value: string): Promise<void> => {
    if (selected === undefined) return
    setBusy('label')
    setError(undefined)
    try {
      await ompApi<null>('ompHistory/label', { sessionId, entryId: selected.id, label: value })
      setLabelEdit(undefined)
      setNotice(t('notice.labelSaved'))
      refresh(selected.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const moveSelection = (delta: number, wrap: boolean): void => {
    if (visibleRows.length === 0) return
    const current = selectedId !== undefined ? visibleIndexById.get(selectedId) : undefined
    const base = current ?? visibleRows.length - 1
    let next = base + delta
    if (wrap) next = (next + visibleRows.length) % visibleRows.length
    else next = Math.max(0, Math.min(visibleRows.length - 1, next))
    setSelectedId(visibleRows[next]?.node.id)
  }

  const moveToAdjacentTurn = (direction: -1 | 1): void => {
    const current = selectedId !== undefined ? visibleIndexById.get(selectedId) : undefined
    if (current === undefined) return
    for (let index = current + direction; index >= 0 && index < visibleRows.length; index += direction) {
      const kind = (visibleRows[index] as FlatRow).node.kind
      if (kind === 'user' || kind === 'assistant') {
        setSelectedId((visibleRows[index] as FlatRow).node.id)
        return
      }
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Alt+↑/↓ jumps between turns (TUI semantics) before plain row stepping.
    if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault()
      moveToAdjacentTurn(1)
      return
    }
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault()
      moveToAdjacentTurn(-1)
      return
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_H))
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveSelection(1, true)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveSelection(-1, true)
        break
      case 'Home':
        event.preventDefault()
        if (visibleRows.length > 0) setSelectedId((visibleRows[0] as FlatRow).node.id)
        break
      case 'End':
        event.preventDefault()
        if (visibleRows.length > 0) setSelectedId((visibleRows.at(-1) as FlatRow).node.id)
        break
      case 'PageUp':
        event.preventDefault()
        moveSelection(-page, false)
        break
      case 'PageDown':
        event.preventDefault()
        moveSelection(page, false)
        break
      case 'Enter':
        event.preventDefault()
        void rewind()
        break
      default:
        break
    }
  }

  if (error !== undefined && nodes === undefined) {
    return <div className={css.historyEmpty}>{error}</div>
  }
  if (nodes === undefined) return <div className={css.historyEmpty}>{t('loading')}</div>
  if (nodes.length === 0) return <div className={css.historyEmpty}>{t('empty.none')}</div>

  const filterLabelKey = FILTER_MODES.find(mode => mode.id === filterMode)?.key ?? 'filter.default'
  const emptyState = visibleRows.length === 0
    ? query !== ''
      ? t('empty.search', { query })
      : t('empty.filter', { count: nodes.length })
    : undefined

  return (
    <div className={css.historyPanes} data-conversation-composer-overlay="">
      <div className={css.historyTreePane}>
        <div className={css.historyToolbar}>
          <Input
            className={css.historySearch ?? ''}
            value={query}
            placeholder={t('search.placeholder')}
            aria-label={t('search.label')}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setQuery(event.target.value) }}
          />
          <Menu
            open={filterOpen}
            onClose={() => { setFilterOpen(false) }}
            items={FILTER_MODES.map(mode => ({ id: mode.id, label: t(mode.key) }))}
            selectedId={filterMode}
            onSelect={(id: string) => {
              setFilterMode(id as FilterMode)
              setFilterOpen(false)
            }}
            align="end"
            portal
            anchor={(
              <button
                type="button"
                className={css.filterControl}
                aria-haspopup="menu"
                aria-expanded={filterOpen}
                aria-label={t('filter.label')}
                onClick={() => { setFilterOpen(state => !state) }}
              >
                {t(filterLabelKey)}
                <IconChevronDownOutline14 className={css.chevron} />
              </button>
            )}
          />
        </div>
        <div className={css.historyTreeViewport}>
          <canvas ref={canvasRef} className={css.historyCanvas} aria-hidden />
          <div
            ref={scrollRef}
            className={css.historyTreeScroll}
            role="tree"
            aria-label={t('pane.tree')}
            tabIndex={0}
            onKeyDown={onKeyDown}
          >
            {emptyState !== undefined ? (
              <div className={css.historyEmpty}>{emptyState}</div>
            ) : (
              <div className={css.historyTreeContent}>
                {visibleRows.map(row => {
                  const node = row.node
                  const roleKey = ROLE_KEY[node.kind]
                  const isSelected = node.id === selectedId
                  return (
                    <div
                      key={node.id}
                      ref={element => {
                        if (element === null) rowRefs.current.delete(node.id)
                        else rowRefs.current.set(node.id, element)
                      }}
                      role="treeitem"
                      aria-selected={isSelected}
                      aria-level={row.depth + 1}
                      className={isSelected ? css.treeRowSelected : css.treeRow}
                      style={{ paddingLeft: dotX(row.depth) + TEXT_PAD }}
                      onClick={() => { setSelectedId(node.id) }}
                    >
                      {node.label !== undefined ? <span className={css.treeLabelBadge}>[{node.label}]</span> : null}
                      {roleKey !== undefined ? (
                        <>
                          <span className={
                            `${css.kindTag} ${node.kind === 'user' ? css.tagUser
                              : node.kind === 'assistant' ? css.tagAssistant
                                : css.tagDeveloper}`
                          }>
                            {t(roleKey)}
                          </span>
                          <span className={node.kind === 'assistant' && node.errorOrAborted ? css.treeTextError : css.treeText}>
                            {displayText(node, t)}
                          </span>
                        </>
                      ) : (
                        <span className={css.treeTextMuted}>{displayText(node, t)}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className={css.historyDetailPane}>
        <div className={css.historyTreeHead}>{t('pane.detail')}</div>
        {selected === undefined ? (
          <div className={css.desc}>{t('detail.select')}</div>
        ) : (
          <>
            <div className={css.detailMeta}>
              <Pill className={css.tag ?? ''}>{kindLabel(selected, t)}</Pill>
              <span className={css.desc}>{new Date(selected.timestamp).toLocaleString()}</span>
              <Pill className={selected.onCurrentPath ? css.tagAccent ?? '' : css.tag ?? ''}>
                {t(selected.onCurrentPath ? 'detail.currentPath' : 'detail.otherPath')}
              </Pill>
            </div>
            <div className={css.detailBody}>{displayText(selected, t)}</div>
            <div className={css.detailLabelRow}>
              <span className={css.desc}>
                {t('detail.label')}
                :
                {selected.label !== undefined ? ` [${selected.label}]` : ` ${t('detail.noLabel')}`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== undefined}
                onClick={() => { setLabelEdit({ entryId: selected.id, value: selected.label ?? '' }) }}
              >
                {t('action.label')}
              </Button>
            </div>
            <div className={css.actionBar}>
              <Button
                variant="primary"
                size="sm"
                disabled={busy !== undefined}
                title={t('action.rewind')}
                onClick={() => { void rewind() }}
              >
                {busy === 'rewind' ? t('action.rewindBusy') : t('action.rewind')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                icon={<IconBranchOutline16 />}
                disabled={busy !== undefined}
                title={t('action.fork')}
                onClick={() => { void forkHere() }}
              >
                {busy === 'fork' ? t('action.forkBusy') : t('action.fork')}
              </Button>
            </div>
            {summarizeChoice?.entryId === selected.id ? (
              <div className={css.choiceStrip}>
                <span className={css.desc}>{t('summary.question')}</span>
                <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => { void rewind({ summarize: false }) }}>
                  {t('summary.no')}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => { void rewind({ summarize: true }) }}>
                  {t('summary.yes')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== undefined}
                  onClick={() => { setCustomPrompt({ entryId: selected.id, value: '' }); setSummarizeChoice(undefined) }}
                >
                  {t('summary.custom')}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => { setSummarizeChoice(undefined) }}>
                  {t('summary.cancel')}
                </Button>
              </div>
            ) : null}
            {customPrompt?.entryId === selected.id ? (
              <div className={css.choicePrompt}>
                <Input
                  className={css.historySearch ?? ''}
                  value={customPrompt.value}
                  placeholder={t('summary.customPromptPlaceholder')}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    setCustomPrompt({ entryId: selected.id, value: event.target.value })
                  }}
                  onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
                    if (event.key === 'Enter') void rewind({ summarize: true, customInstructions: customPrompt.value })
                    if (event.key === 'Escape') setCustomPrompt(undefined)
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== undefined}
                  onClick={() => { void rewind({ summarize: true, customInstructions: customPrompt.value }) }}
                >
                  {t('summary.yes')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setCustomPrompt(undefined) }}>
                  {t('summary.cancel')}
                </Button>
              </div>
            ) : null}
            {labelEdit?.entryId === selected.id ? (
              <div className={css.choicePrompt}>
                <Input
                  className={css.historySearch ?? ''}
                  value={labelEdit.value}
                  placeholder={t('label.placeholder')}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    setLabelEdit({ entryId: selected.id, value: event.target.value })
                  }}
                  onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
                    if (event.key === 'Enter') void saveLabel(labelEdit.value)
                    if (event.key === 'Escape') setLabelEdit(undefined)
                  }}
                />
                <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => { void saveLabel(labelEdit.value) }}>
                  {t('action.labelSave')}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => { void saveLabel('') }}>
                  {t('action.labelClear')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setLabelEdit(undefined) }}>
                  {t('action.labelCancel')}
                </Button>
              </div>
            ) : null}
          </>
        )}
        {notice !== undefined ? <div className={css.desc}>{notice}</div> : null}
        {error !== undefined ? <div className={css.warning}>{error}</div> : null}
      </div>
    </div>
  )
}
