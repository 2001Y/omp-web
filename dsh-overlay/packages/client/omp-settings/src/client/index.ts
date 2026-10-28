/**
 * omp web settings sections: one settings.section per OMP settings tab, plus
 * the session History view tab. Fully catalog-driven — the tab list, labels,
 * and order come from the ompSettings/describe projection (the omp schema
 * stays the single source of truth; this plugin hardcodes nothing but the
 * slots it registers into).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createElement } from 'react'
import { sectionFor, loadCatalog } from './OmpTabSection.tsx'
import { ModelRolesSection } from './ModelRolesSection.tsx'
import { ConnectSection } from './ConnectSection.tsx'
import { HistoryView } from './HistoryView.tsx'
import { NS, en, zh } from './locales.ts'
import './settings-dialog.css'

// Type-only: pull the cross-plugin module merges into this program (the
// ctx.locale Context merge, the settings.section and conversation.view slot
// keys). Cross-plugin collaboration goes through the services, never a value
// import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

// 'conversation' (provided by ui-conversation) gates this plugin's apply on
// ui-conversation's activation — the chat view entry with its store handle
// must already be registered when we attach the same handle below.
export const inject = ['slots', 'locale', 'sessions', 'conversation']

/**
 * Mount the omp settings sections and the History view tab. The History view
 * registers synchronously at apply — a session-scoped entry registered from
 * an async continuation loses its scope binding (the id arrives empty).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'omp-settings: history dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk so it follows the active locale without
  // re-registration; components read the standard `t` seat instead.
  const t = ctx.locale.bind(NS)
  // Share the chat view's per-session store handle: the store seat keys
  // instance sharing by handle identity, so this entry's `actions` prop IS
  // the chat store's bound write set (setView) — the designed way for a view
  // entry to steer the tab ring without any cross-plugin service.
  const chatStoreHandle = (ctx.slots.entries('conversation.view') as unknown as readonly { store?: EngineStoreHandle<never, never> }[])
    .find(entry => entry.store !== undefined)?.store
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'omp-history',
    order: 20,
    locale: NS,
    label: () => t('tab.history'),
    ...(chatStoreHandle !== undefined ? { store: chatStoreHandle } : {}),
    inject: (sessionId: SessionId) => ({
      sessionId,
      // After a fork lands, pull the runtime's session list so the sidebar
      // shows the child without waiting for a reconnect-driven refresh.
      // `refresh` is runtime-internal (not on the ISessions contract), but it
      // is the one list-reload lever a plugin can reach.
      refreshSessions: () => {
        void (ctx.sessions as unknown as { refresh(): Promise<void> }).refresh()
      },
      // Select another session (the fork child) — lands the conversation on
      // it. select() throws for sessions not yet in the client's list, so
      // pull the list and retry instead of racing the session-added frame.
      openSession: async (id: SessionId): Promise<void> => {
        const sessions = ctx.sessions as unknown as {
          open(target: SessionId): void
          refresh(): Promise<void>
        }
        for (let attempt = 0; attempt < 12; attempt++) {
          try {
            sessions.open(id)
            return
          } catch {
            // List not landed yet — refresh and wait briefly.
          }
          await sessions.refresh().catch(() => {})
          await new Promise(resolve => { setTimeout(resolve, 250) })
        }
      },
    }),
  }, HistoryView))
  ctx.inject(['slots'], (scope: ClientContext) => {
    void loadCatalog().then(catalog => {
      for (const [index, tab] of catalog.tabs.entries()) {
        scope.slots.inject('settings.section', () => scope.slots.register({
          name: 'settings.section',
          id: `omp-${tab.id}`,
          order: 50 + index,
          label: tab.label,
        }, sectionFor(tab.id)))
      }
      // The dedicated surfaces ride their own sections next to their related
      // tabs: Model Roles right after Model, Connect right after Providers
      // (equal order + later registration settles after the tab itself).
      scope.slots.inject('settings.section', () => scope.slots.register({
        name: 'settings.section',
        id: 'omp-model-roles',
        order: 50 + catalog.tabs.findIndex(tab => tab.id === 'model'),
        label: 'Model Roles',
      }, () => createElement(ModelRolesSection)))
      scope.slots.inject('settings.section', () => scope.slots.register({
        name: 'settings.section',
        id: 'omp-connect',
        order: 50 + catalog.tabs.findIndex(tab => tab.id === 'providers'),
        label: 'Connect',
      }, () => createElement(ConnectSection)))
    })
  })
}
