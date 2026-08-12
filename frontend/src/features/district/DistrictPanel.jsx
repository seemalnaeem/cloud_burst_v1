import Legend from '@/components/Legend'
import StatusBanner from '@/components/StatusBanner'
import { useAsync } from '@/hooks/useAsync'
import { getCari } from '@/lib/api'
import { contrastText } from '@/lib/color'
import { cariClasses, contracts } from '@/lib/contracts'
import { fmtNumber, fmtPercent, fmtValue } from '@/lib/format'

export default function DistrictPanel ({ district, leadHours }) {
  const cari = useAsync(
    (signal) => getCari(district, leadHours, null, signal),
    [district, leadHours],
    { enabled: Boolean(district) }
  )

  if (!district) {
    return <p className="px-2 py-3 text-sm text-muted">Click a district on the map to score it.</p>
  }

  if (cari.isLoading) {
    return <p className="px-2 py-3 text-sm text-muted">Scoring {district}…</p>
  }

  if (cari.isError) {
    // NOT_CONFIGURED is the expected state until the rasters are ingested, so
    // it reads as information rather than as a failure.
    const isPending = cari.error.code === 'NOT_CONFIGURED'
    return (
      <StatusBanner
        kind={isPending ? 'info' : 'danger'}
        title={isPending ? 'Not scored yet' : 'Could not score this district'}
        message={cari.error.message}
      />
    )
  }

  // Idle, the first frame before the fetch starts, is neither loading nor error
  // yet carries no data. Treat it as scoring so nothing downstream dereferences
  // a null result.
  const result = cari.data
  if (!result) {
    return <p className="px-2 py-3 text-sm text-muted">Scoring {district}…</p>
  }

  const variables = contracts().cari.variables
  // Variables the source left empty at this lead and the scorer read from the
  // nearest lead instead. Keyed by variable to its substitute lead. Surfaced so
  // a value in the panel does not look wrong against a blank raster on the map.
  const fallback = result.leadFallback ?? {}
  const byKey = Object.fromEntries(variables.map((v) => [v.key, v]))

  return (
    <div className="space-y-3 px-1 py-2">
      <div>
        <p className="text-sm font-semibold text-text">{district}</p>
        <p className="text-xs text-muted">
          {result.province} · {result.matrix} matrix
          {result.matrixAuto ? ' (auto)' : ' (forced)'}
        </p>
      </div>

      <div
        className="rounded-cb-sm p-3 text-center"
        style={{ background: result.riskColor, color: contrastText(result.riskColor) }}
      >
        <p className="text-2xl font-bold">{fmtPercent(result.cari)}</p>
        <p className="text-sm font-medium">{result.riskLevel}</p>
        {result.overrideApplied && (
          // Worth surfacing. Without it a class that sits above what the
          // percentage suggests looks like a bug rather than the rule working.
          <p className="mt-1 text-xs opacity-90">Raised by the primary extreme rule</p>
        )}
      </div>

      <div className="rounded-cb-sm border border-border bg-panel-2 p-2">
        <p className="mb-1 text-xs font-semibold text-text-2">
          Score {fmtNumber(result.cas, 2)} of {fmtNumber(result.casMax, 1)}
        </p>
        <ul className="space-y-0.5">
          {variables.map((spec) => (
            <li key={spec.key} className="flex items-center gap-2 text-xs">
              <span className="w-14 shrink-0 text-muted">{spec.key}</span>
              <span className="flex-1 truncate text-text-2">
                {fmtValue(result.values?.[spec.key], spec.unit)}
                {fallback[spec.key] != null && (
                  <sup className="ml-0.5 text-[9px] text-amber" title={`Empty at this lead, read from lead ${fallback[spec.key]}h`}>
                    †{fallback[spec.key]}h
                  </sup>
                )}
              </span>
              <span
                className="w-5 shrink-0 rounded text-center font-medium"
                style={{
                  background: 'var(--cb-chip)',
                  color: 'var(--cb-chip-text)'
                }}
              >
                {result.scores?.[spec.key] ?? 0}
              </span>
              <span className="w-8 shrink-0 text-right text-[10px] text-muted">
                {spec.tier === 'primary' ? '1.0x' : '0.75x'}
              </span>
            </li>
          ))}
        </ul>
        {Object.keys(fallback).length > 0 && (
          <p className="mt-1.5 border-t border-border pt-1.5 text-[10px] leading-snug text-muted">
            <span className="text-amber">†</span>{' '}
            {Object.entries(fallback)
              .map(([key, lead]) => `${byKey[key]?.label ?? key} read from lead ${lead}h`)
              .join(', ')}
            , empty at this step in the source.
          </p>
        )}
      </div>

      <Legend title="CARI risk classes" kind="classed" classes={cariClasses()} />
    </div>
  )
}
