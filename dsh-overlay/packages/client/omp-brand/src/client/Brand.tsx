/**
 * OMP Harness brand occupants for the generic browser-brand slots — a
 * pastiche of the official DeepSeek Harness lockup (mark + wordmark +
 * HARNESS badge) rebuilt for OMP, under the fork's overlay rule: the
 * vendored tree stays unmodified and colors come only from `--dsw-*`
 * tokens (the OMP gold itself arrives as a theme-token layer, see
 * index.ts) — the mark paints in `--dsw-alias-brand-primary`.
 *
 * The mark is constructed geometrically on the fish mark's stage
 * (viewBox 0 0 24 18): a filled π — Oh My Pi's initial glyph — drawn from
 * primitives, never traced. Cap bar: x 2→22, y 3.6→7.1 with semicircular
 * ends (r 1.75). Legs: width 3.8 (x 4.4→8.2 and 15.8→19.6), hanging to
 * y 15.4 with r 1.5 foot corners; the right leg's outer edge bows out by
 * 0.4 at mid-height, echoing the whale's raised tail. The whale's eye
 * survives as a knockout circle (r 1.25) centered between the legs at
 * (12, 11.4). Subpaths wind clockwise; the eye winds counter-clockwise,
 * so the default nonzero fill unions the body and knocks the eye out.
 */

/** Native viewBox of {@link OMP_MARK_PATH} (width and height in user units). */
export const OMP_MARK_VIEWBOX = { width: 24, height: 18 }

/** The π mark path data, exported for consumers that compose their own svg (the host favicon assets reuse the same geometry). */
export const OMP_MARK_PATH =
  'M3.75 3.6 H20.25 A1.75 1.75 0 0 1 20.25 7.1 H3.75 A1.75 1.75 0 0 1 3.75 3.6 Z' +
  'M4.4 6.1 H8.2 V13.9 A1.5 1.5 0 0 1 6.7 15.4 H5.9 A1.5 1.5 0 0 1 4.4 13.9 Z' +
  'M15.8 6.1 H19.6 Q20.35 11 19.6 13.9 A1.5 1.5 0 0 1 18.1 15.4 H17.3 A1.5 1.5 0 0 1 15.8 13.9 Z' +
  'M10.75 11.4 A1.25 1.25 0 1 0 13.25 11.4 A1.25 1.25 0 1 0 10.75 11.4 Z'

/** Owner props shared by the brand-mark slots (sidebar mark, hero mark). */
export interface OmpBrandMarkProps {
  /** Requested width in pixels; height keeps the 24:18 ratio. */
  size?: number | undefined
  /** Host class preserving the surrounding mark geometry. */
  className?: string | undefined
}

/**
 * Render the π brand mark.
 * @param props.size - width in px (default 24; height keeps the 24:18 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the mark svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function OmpBrandMark({ size = 24, className }: OmpBrandMarkProps) {
  return (
    <svg
      width={size}
      height={(size * OMP_MARK_VIEWBOX.height) / OMP_MARK_VIEWBOX.width}
      className={className === undefined ? 'omp-brand-mark' : `omp-brand-mark ${className}`}
      viewBox={`0 0 ${OMP_MARK_VIEWBOX.width} ${OMP_MARK_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={OMP_MARK_PATH} fill="currentColor" />
    </svg>
  )
}

/**
 * Render the brand name: the OMP wordmark typeset beside a HARNESS badge,
 * mirroring the official lockup's badge grammar (inverted letters on a
 * filled rounded rect) with typeset text instead of letterform artwork.
 * @returns the wordmark element (aria-hidden decorative brand art).
 */
export function OmpBrandName() {
  return (
    <span className="omp-brand-name" aria-hidden="true">
      <span className="omp-brand-name-text">OMP</span>
      <span className="omp-brand-name-badge">HARNESS</span>
    </span>
  )
}
