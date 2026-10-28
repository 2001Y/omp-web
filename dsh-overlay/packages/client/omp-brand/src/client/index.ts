/**
 * OMP Web brand plugin: fills the generic browser-brand slots (sidebar
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
 * this plugin removes the layer). The whole accent family is re-based on
 * OMP's gold (the TUI accent #febc38):
 *
 * - the brand tokens proper (primary actions; the badge and mark paint
 *   from them, with a deep warm near-black as the on-brand label);
 * - the send button's token, which the light palette carries as a
 *   literal blue instead of a scale reference;
 * - the deepseek static scale itself, re-hued step for step — every
 *   alias that referenced the blue scale (links, info buttons, business
 *   states, message bubbles, sidebar accents, the deep-diving mixes)
 *   follows from the palette root instead of being chased surface by
 *   surface. Light steps deepen toward the text end, where the raw gold
 *   is illegible on white; dark steps stay vivid.
 *
 * Brand text and blue-950 (only the deep-diving mixes' dark partner)
 * follow the same logic.
 */
const OMP_TOKEN_OVERRIDES: ThemeTokenOverrides = {
  '--dsw-alias-brand-primary': { light: '#febc38', dark: '#febc38' },
  '--dsw-alias-brand-primary-invert': { light: '#221a04', dark: '#221a04' },
  '--dsw-alias-brand-text': { light: '#a66e00', dark: '#febc38' },
  '--dsw-alias-brand-primary-new-colorprimary-new-color': { light: '#dd9a0c', dark: '#febc38' },
  '--dsw-alias-bg-document-selection': {
    light: 'color-mix(in srgb, #febc38 45%, transparent)',
    dark: 'color-mix(in srgb, #febc38 45%, transparent)',
  },
  '--dsw-static-deepseek-50': { light: '#fdf6e0', dark: '#fdf6e0' },
  '--dsw-static-deepseek-100': { light: '#fbeec3', dark: '#fbeec3' },
  '--dsw-static-deepseek-200': { light: '#f7df9a', dark: '#f7df9a' },
  '--dsw-static-deepseek-300': { light: '#f0c75e', dark: '#f3cd68' },
  '--dsw-static-deepseek-400': { light: '#e3aa22', dark: '#fec44a' },
  '--dsw-static-deepseek-450': { light: '#cf8f06', dark: '#febc38' },
  '--dsw-static-deepseek-500': { light: '#a66e00', dark: '#febc38' },
  '--dsw-static-deepseek-600': { light: '#8a5f04', dark: '#d99e06' },
  '--dsw-static-deepseek-700-delete': { light: '#6e4c05', dark: '#a87408' },
  '--dsw-static-deepseek-800': { light: '#4d3f1c', dark: '#4d3f1c' },
  '--dsw-static-deepseek-900': { light: '#382e13', dark: '#382e13' },
  '--dsw-static-blue-950': { light: '#2a2008', dark: '#2a2008' },
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
