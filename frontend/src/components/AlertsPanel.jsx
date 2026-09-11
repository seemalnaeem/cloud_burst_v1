// The Alerts panel.
//
// A standing panel in the Analysis tab, bottom right, that presents the latest
// PMD rain-wind advisory as a running carousel of convective-activity alerts
// rather than sending the user to the source page. It also carries the Extreme
// Events control: a per-day view that flashes the districts or tehsils whose
// daily-accumulated-precipitation CARI is extreme, independent of the timeline.
// It is always present while the Analysis tab is open, so it also carries the
// "not configured", "no advisory" and "feed down" states. Every surface is
// theme-token styled, so it reads on both the light and dark panel.

import { TbAlertTriangle, TbBolt, TbChevronLeft, TbChevronRight } from 'react-icons/tb'

import AlertsCarousel from './AlertsCarousel'
import { ThemedSelect } from './ForecastChartPanel'
import { Panel } from './ui/Panel'

const ALERT_RED = '#ef4444'

function Empty ({ children }) {
  return <p className="px-3 py-5 text-center text-[11.5px] leading-snug text-muted">{children}</p>
}

// The master switch for advisory alert flashing, in the panel header. Separate
// from Extreme Events so the two red flashes can be told apart: turn this off to
// read the Extreme Events flash on its own. Carries an ON/OFF label.
function FlashSwitch ({ on, onToggle }) {
  // A rectangular switch with the ON/OFF label inside and a square thumb, kept
  // vertically centred with the translate trick so it never reads as offset. The
  // label sits in the gap the thumb leaves: left when on, right when off.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Toggle advisory alert flashing"
      onClick={onToggle}
      className={`relative h-5 w-[52px] shrink-0 rounded-[3px] border transition-colors ${
        on ? 'border-danger bg-danger' : 'border-border-strong bg-panel-2'
      }`}
    >
      <span
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-[9px] font-bold uppercase tracking-[0.08em] ${
          on ? 'left-[8px] text-white' : 'right-[7px] text-muted'
        }`}
      >
        {on ? 'On' : 'Off'}
      </span>
      <span
        className={`pointer-events-none absolute top-1/2 h-[14px] w-[15px] -translate-y-1/2 rounded-[2px] bg-white shadow-sm transition-all duration-200 ${
          on ? 'left-[34px]' : 'left-[3px]'
        }`}
      />
    </button>
  )
}

// Walk the advisory provinces one at a time: each step focuses a single province,
// flashing only its districts and flying the map to it. Shown only when there is
// more than one province to step between.
function Stepper ({ provinces, provincesOn, onStep }) {
  if (!onStep || provinces.length < 2) return null
  const focused = provincesOn?.size === 1 ? [...provincesOn][0] : null
  const btn = 'grid h-6 w-6 shrink-0 place-items-center rounded-cb-sm border border-border bg-panel text-text-2 transition-colors hover:border-border-strong hover:text-text'
  return (
    <div className="mx-3 mb-2 flex items-center gap-2 rounded-cb-sm border border-border bg-panel-2/50 px-2 py-1.5">
      <span className="shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.07em] text-muted">Review</span>
      <span className={`min-w-0 flex-1 truncate text-center text-[11px] font-medium ${focused ? 'text-text' : 'text-muted'}`}>
        {focused || 'All provinces'}
      </span>
      <button type="button" onClick={() => onStep(-1)} aria-label="Previous province" className={btn}>
        <TbChevronLeft className="text-[13px]" aria-hidden />
      </button>
      <button type="button" onClick={() => onStep(1)} aria-label="Next province" className={btn}>
        <TbChevronRight className="text-[13px]" aria-hidden />
      </button>
    </div>
  )
}

// The Extreme Events control: a toggle plus, once on, a day dropdown. Selecting a
// day flashes the day's extreme regions on the map. The days come from the backend
// (the cycle's covered forecast days); the summary line reflects the day's result.
function ExtremeControl ({ enabled, days, day, onToggle, onSelectDay, count, status }) {
  const options = days.map((d) => ({ value: d.index, label: d.label }))
  const summary = status === 'computing'
    ? 'Scoring the day…'
    : status === 'error'
      ? 'Could not score this day.'
      : day == null
        ? 'Pick a day to flag extreme regions.'
        : `${count} region${count === 1 ? '' : 's'} extreme on this day, flashing on the map.`

  return (
    <div className="mx-3 mb-2 rounded-cb-sm border border-border bg-panel-2/50 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={enabled}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-cb-sm border px-2.5 py-1.5 text-[12.5px] font-semibold transition-colors ${
            enabled ? 'border-danger bg-danger-soft text-danger' : 'border-border bg-panel text-text-2 hover:border-border-strong hover:text-text'
          }`}
        >
          <TbBolt className="text-[13px]" aria-hidden />
          Extreme Events
        </button>
        {enabled && options.length > 0 && (
          <ThemedSelect
            tag="Day"
            ariaLabel="Forecast day"
            value={day ?? options[0].value}
            options={options}
            onChange={onSelectDay}
            className="min-w-0 flex-1"
          />
        )}
      </div>
      {enabled && (
        <p className="mt-1.5 text-[10px] leading-snug text-muted">
          {options.length === 0 ? 'No forecast days are available right now.' : summary}
        </p>
      )}
    </div>
  )
}

export default function AlertsPanel ({
  release, provinces = [], cari = {}, configured = true, error, provincesOn, onStepAlert,
  alertsFlashOn = true, onToggleAlertsFlash,
  extremeEnabled = false, extremeDays = [], extremeDay = null, onToggleExtreme,
  onSelectExtremeDay, extremeCount = 0, extremeStatus = 'idle'
}) {
  // When the stepper has singled out one province, the carousel and the count
  // follow it; otherwise every province's alerts scroll, as they do by default.
  const focused = provincesOn?.size === 1 ? [...provincesOn][0] : null
  const shown = focused ? provinces.filter((p) => p.province === focused) : provinces
  const total = shown.reduce((n, p) => n + p.districts.length, 0)
  const has = Boolean(release) && provinces.length > 0

  return (
    <Panel
      title="Convective Alerts"
      icon={TbAlertTriangle}
      accent={ALERT_RED}
      className="flex max-h-[calc(100vh-5.5rem)] w-[min(360px,calc(100vw-2rem))] flex-col"
      bodyClassName="py-3"
      actions={has
        ? (
          <div className="flex items-center gap-2.5">
            {onToggleAlertsFlash && <FlashSwitch on={alertsFlashOn} onToggle={onToggleAlertsFlash} />}
            <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-danger-soft px-1.5 py-0.5 text-[10.5px] font-bold text-danger tabular-nums">
              {total}
            </span>
          </div>
          )
        : undefined}
      footer={has && release?.date
        ? (
          <div className="flex items-center justify-between text-[10px] text-muted">
            <span className="font-medium text-danger">PMD rain-wind advisory</span>
            <span>Issued {release.date}</span>
          </div>
          )
        : undefined}
    >
      {!configured ? (
        <Empty>The advisory source is not configured.</Empty>
      ) : (
        <>
          {onToggleExtreme && (
            <ExtremeControl
              enabled={extremeEnabled}
              days={extremeDays}
              day={extremeDay}
              onToggle={onToggleExtreme}
              onSelectDay={onSelectExtremeDay}
              count={extremeCount}
              status={extremeStatus}
            />
          )}
          {!has ? (
            <Empty>{error ? 'The advisory feed is unavailable right now.' : 'No active rain-wind advisory right now.'}</Empty>
          ) : (
            <>
              <Stepper provinces={provinces} provincesOn={provincesOn} onStep={onStepAlert} />
              <AlertsCarousel key={focused || 'all'} provinces={shown} cari={cari} />
            </>
          )}
        </>
      )}
    </Panel>
  )
}
