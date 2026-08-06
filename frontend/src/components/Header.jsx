import { FiClock, FiMoon, FiSun } from 'react-icons/fi'
import { WiCloudyGusts } from 'react-icons/wi'

import LeadSlider from '@/components/LeadSlider'
import { useAsync } from '@/hooks/useAsync'
import { useTheme } from '@/hooks/useTheme'
import { getForecastMeta } from '@/lib/api'
import { fmtCycle } from '@/lib/format'

export default function Header ({ leadHours, onLeadChange }) {
  const { isDark, toggle } = useTheme()
  const meta = useAsync((signal) => getForecastMeta(signal), [])

  const hasCycle = meta.isReady && meta.data?.status === 'ok'

  return (
    <header
      className="flex flex-wrap items-center gap-4 rounded-cb px-5 py-3 shadow-cb"
      style={{ background: 'var(--cb-header)', border: '1px solid var(--cb-header-border)' }}
    >
      <div className="flex items-center gap-3">
        <WiCloudyGusts size={30} style={{ color: 'var(--cb-cream)' }} aria-hidden="true" />
        <div>
          <h1 className="text-lg font-semibold leading-tight" style={{ color: 'var(--cb-cream)' }}>
            Cloud Burst Portal
          </h1>
          <p className="text-xs" style={{ color: 'var(--cb-header-text)' }}>
            Convective risk monitoring for Pakistan
          </p>
        </div>
      </div>

      <div className="flex-1" />

      <div
        className="flex items-center gap-2 rounded-full px-3 py-1.5 text-xs"
        style={{
          color: 'var(--cb-header-pill-text)',
          background: 'var(--cb-header-pill-bg)',
          border: '1px solid var(--cb-header-pill-border)'
        }}
      >
        <FiClock size={14} aria-hidden="true" />
        {hasCycle ? (
          <span>Cycle {fmtCycle(meta.data.creationTime)}</span>
        ) : (
          <span>No forecast cycle ingested</span>
        )}
      </div>

      {hasCycle && (
        <LeadSlider
          value={leadHours}
          onChange={onLeadChange}
          publishedLeads={meta.data.publishedLeads}
          minLead={meta.data.minLeadHours}
        />
      )}

      <button
        type="button"
        onClick={toggle}
        aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        className="rounded-full p-2 transition-colors"
        style={{ color: 'var(--cb-cream)', background: 'var(--cb-header-pill-bg)' }}
      >
        {isDark ? <FiSun size={16} aria-hidden="true" /> : <FiMoon size={16} aria-hidden="true" />}
      </button>
    </header>
  )
}
