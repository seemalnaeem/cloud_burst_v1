// Legend for a single layer, rendered inside the layers panel under the layer
// name. Never a separate floating legend that has to be opened, and never
// something the user has to switch on: if a layer is listed, its legend is
// there with it.
//
// The swatch is drawn from the layer's own `color` in the contract, the same
// value the map paints with, so the two cannot disagree.
//
// Continuous palettes are drawn as discrete steps rather than a CSS gradient.
// No gradients anywhere is a project rule, and stepped swatches are arguably
// the more honest rendering of a classed palette anyway.

const swatchBase = 'h-3.5 w-3.5 shrink-0 rounded-[3px]'

/** The mark that identifies a layer: a fill, an outline, a dash or a dot. */
export function LayerSwatch ({ color, render = 'fill', className = '' }) {
  if (render === 'circle') {
    return (
      <span
        className={`${swatchBase} rounded-full ${className}`}
        style={{ background: color, boxShadow: '0 0 0 1.5px #ffffff, 0 0 0 2.5px rgba(16,24,40,0.18)' }}
      />
    )
  }

  if (render === 'outline') {
    return (
      <span
        className={`${swatchBase} ${className}`}
        style={{ background: `${color}24`, border: `2px solid ${color}` }}
      />
    )
  }

  if (render === 'dashed') {
    return (
      <span
        className={`${swatchBase} ${className}`}
        style={{ background: `${color}24`, border: `2px dashed ${color}` }}
      />
    )
  }

  return (
    <span
      className={`${swatchBase} ${className}`}
      style={{ background: `${color}59`, border: `1.5px solid ${color}` }}
    />
  )
}

/**
 * A classed palette as discrete swatches.
 *
 * Used for CARI risk classes, susceptibility classes and any raster palette.
 * Each class carries its own label, so this doubles as the value scale.
 */
function ClassScale ({ classes }) {
  if (!classes?.length) return null

  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {classes.map((c) => (
        <li key={c.name ?? c.label ?? c.color} className="flex items-center gap-2">
          <span
            className="h-3 w-3 shrink-0 rounded-[3px]"
            style={{ background: c.color, border: '1px solid rgba(16,24,40,0.14)' }}
          />
          <span className="min-w-0 flex-1 truncate text-[11px] text-text-2">{c.name ?? c.label}</span>
          {c.max !== undefined && (
            <span className="shrink-0 font-mono text-[10px] text-muted">{`≤ ${c.max}`}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * A continuous palette, stepped.
 *
 * Rendered as a row of touching solid blocks with the range labelled at each
 * end. Reads like a ramp, contains no gradient.
 */
function SteppedScale ({ colors, min, max, unit }) {
  if (!colors?.length) return null

  return (
    <div className="mt-1.5">
      <div className="flex h-3 overflow-hidden rounded-[3px] ring-1 ring-inset ring-[rgba(16,24,40,0.1)]">
        {colors.map((color, i) => (
          <span key={`${color}-${i}`} className="flex-1" style={{ background: color }} />
        ))}
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-muted">
        <span>{min}</span>
        {unit && <span className="font-sans text-[10px]">{unit}</span>}
        <span>{max}</span>
      </div>
    </div>
  )
}

/**
 * The legend for one layer.
 *
 * `scale` is optional and only present once a layer is actually painted by
 * data. Until then the legend is the layer's identity swatch and its
 * description, which is still worth showing: it tells you what the colour on
 * the map means before you have any scores loaded.
 */
export default function LayerLegend ({ layer, scale }) {
  const legend = layer.legend ?? {}

  return (
    <div className="pl-[26px] pr-1">
      <div className="flex items-start gap-2">
        <LayerSwatch color={layer.color} render={legend.render} className="mt-[2px]" />
        <p className="min-w-0 flex-1 text-[11px] leading-[1.45] text-muted">
          {legend.description ?? layer.label}
        </p>
      </div>

      {scale?.kind === 'classes' && <ClassScale classes={scale.classes} />}
      {scale?.kind === 'steps' && (
        <SteppedScale colors={scale.colors} min={scale.min} max={scale.max} unit={scale.unit} />
      )}
    </div>
  )
}
