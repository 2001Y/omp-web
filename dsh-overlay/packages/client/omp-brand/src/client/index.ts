/**
 * OMP Harness brand plugin: fills the generic browser-brand slots (sidebar
 * mark/name, conversation hero mark) with the OMP lockup and layers the OMP
 * colors over the theme's brand tokens. This is the fork's counterpart to
 * the tree's ui-brand-official — a standalone plugin the host rosters by
 * default; dropping it from the roster restores the stock DSH branding.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import { OmpBrandMark, OmpBrandName } from './Brand.tsx'
import './brand.css'

// Type-only: pull the cross-plugin module merges into this program (the
// brand slot keys and the ctx.theme service). Cross-plugin collaboration
// goes through the services, never a value import (client bundle purity
// gate).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'

/** Required services: the UI slot registry and the theme runtime. */
export const inject = ['slots', 'theme']

/**
 * The OMP color layer, stacked over the active base palette through the
 * theme service's override seam (the base theme stays untouched; removing
 * this plugin removes the layer). Values are OMP's own: the TUI accent
 * #febc38. Brand text deepens the same gold on the light palette, where
 * the raw accent is illegible as text.
 */
const OMP_TOKEN_OVERRIDES: ThemeTokenOverrides = {
  '--dsw-alias-brand-primary': { light: '#febc38', dark: '#febc38' },
  '--dsw-alias-brand-primary-invert': { light: '#221a04', dark: '#221a04' },
  '--dsw-alias-brand-text': { light: '#a66e00', dark: '#febc38' },
}

/**
 * Mount the brand occupants and the color layer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.theme.overrideTokens('@omp/client-brand', OMP_TOKEN_OVERRIDES), 'omp-brand: OMP token layer')
  // The generator form installs the three registrations atomically,
  // mirroring ui-brand-official's declaration-aware pattern.
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, OmpBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, OmpBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, OmpBrandMark)
      })))
}
