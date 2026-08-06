// The layers dock.
//
// One row per layer: a toggle, the layer name, a feature count, and the legend
// sitting directly underneath it. The legend is not behind a disclosure and not
// in a separate panel, because the question "what does this colour mean" comes
// up at exactly the moment you are looking at the layer list.

import { useState } from 'react'
import { TbStack2, TbEye, TbEyeOff, TbAdjustmentsHorizontal, TbLayersOff } from 'react-icons/tb'

import LayerLegend from './LayerLegend'
import { Panel, IconButton } from './ui/Panel'

function Toggle ({ checked, onChange, color, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className="relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors duration-200"
      style={{ background: checked ? color : 'var(--cb-toggle-off)' }}
    >
      <span
        className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-[var(--cb-knob)] transition-all duration-200"
        style={{ left: checked ? '16px' : '2px', boxShadow: 'var(--cb-knob-shadow)' }}
      />
    </button>
  )
}

function LayerRow ({ layer, visible, onToggle, count, scale, opacity, onOpacity }) {
  const [tuning, setTuning] = useState(false)

  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <Toggle checked={visible} onChange={onToggle} color={layer.color} label={`Show ${layer.label}`} />

        <span className={`min-w-0 flex-1 truncate text-[13px] font-medium ${visible ? 'text-text' : 'text-text-2'}`}>
          {layer.label}
        </span>

        {count != null && (
          <span className="shrink-0 font-mono text-[10.5px] text-muted tabular-nums">{count}</span>
        )}

        <IconButton
          icon={TbAdjustmentsHorizontal}
          label="Layer opacity"
          size="sm"
          tone="ghost"
          active={tuning}
          disabled={!visible}
          onClick={() => setTuning((v) => !v)}
        />
      </div>

      <div className="pb-2.5">
        <LayerLegend layer={layer} scale={scale} />

        {tuning && visible && (
          <div className="mt-2 flex items-center gap-2 pl-[26px] pr-3">
            <span className="text-[10.5px] text-muted">Opacity</span>
            <input
              type="range"
              min="10"
              max="100"
              value={Math.round(opacity * 100)}
              onChange={(e) => onOpacity(Number(e.target.value) / 100)}
              className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-[var(--cb-track)]"
              style={{ accentColor: layer.color }}
            />
            <span className="w-8 shrink-0 text-right font-mono text-[10.5px] text-muted tabular-nums">
              {Math.round(opacity * 100)}%
            </span>
          </div>
        )}
      </div>
    </li>
  )
}

export default function LayersPanel ({
  layers,
  visibleLayers,
  onToggleLayer,
  onShowAll,
  onHideAll,
  counts = {},
  scales = {},
  opacities = {},
  onOpacity,
  collapsed,
  onCollapse
}) {
  const visibleCount = layers.filter((l) => visibleLayers.has(l.id)).length
  const allVisible = layers.length > 0 && visibleCount === layers.length

  return (
    <Panel
      title="Layers"
      icon={TbStack2}
      collapsed={collapsed}
      onToggle={onCollapse}
      className="max-h-[calc(100vh-8.5rem)] w-[310px]"
      actions={
        // One button that carries its own state, not two that sit side by side
        // arguing. The icon shows what the map is now; pressing it does the
        // other thing.
        <IconButton
          icon={allVisible ? TbEye : TbEyeOff}
          label={allVisible ? 'Hide all layers' : 'Show all layers'}
          size="sm"
          tone="ghost"
          onClick={allVisible ? onHideAll : onShowAll}
        />
      }
      footer={
        <div className="flex items-center justify-between text-[11px] text-muted">
          <span>{visibleCount} of {layers.length} visible</span>
          <span className="font-mono">EPSG:4326</span>
        </div>
      }
    >
      {layers.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <TbLayersOff className="text-2xl text-muted" aria-hidden />
          <p className="text-[12px] text-muted">No layers are published yet.</p>
        </div>
      ) : (
        <ul>
          {layers.map((layer) => (
            <LayerRow
              key={layer.id}
              layer={layer}
              visible={visibleLayers.has(layer.id)}
              onToggle={() => onToggleLayer(layer.id)}
              count={counts[layer.id]}
              scale={scales[layer.id]}
              opacity={opacities[layer.id] ?? 1}
              onOpacity={(v) => onOpacity(layer.id, v)}
            />
          ))}
        </ul>
      )}
    </Panel>
  )
}
