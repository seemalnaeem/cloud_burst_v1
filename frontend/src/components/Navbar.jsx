// The top navigation bar.
//
// Fixed brand teal in both themes, per COLOR_SCHEMES.md section 5. Everything
// sitting on it is therefore also fixed, because the surface underneath never
// changes. Flat fill, no gradient.
//
// The bar carries identity on the left, view switching in the middle and
// session state on the right. Nothing that belongs to the map lives up here;
// map concerns belong on the map.

import { useEffect, useState } from 'react'
import {
  TbMap2, TbCloud, TbChartBar, TbSun, TbMoon,
  TbMenu2, TbRadar2
} from 'react-icons/tb'

import { IconButton } from './ui/Panel'
import ndmaLogo from '@/assets/ndma_logo.webp'

// Map first, then the two analytical views, Radar last. Radar carries the alerts
// once its logic lands, so there is no separate alerts tab.
const VIEWS = [
  { id: 'map', label: 'Map', icon: TbMap2 },
  { id: 'forecast', label: 'Forecast', icon: TbCloud },
  { id: 'analysis', label: 'Analysis', icon: TbChartBar },
  { id: 'radar', label: 'Radar', icon: TbRadar2 }
]

function Clock () {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])

  const time = now.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi'
  })

  return (
    <span className="hidden font-mono text-[12.5px] font-medium text-cream tabular-nums lg:inline">
      {time} <span className="text-[10px] font-normal opacity-70">PKT</span>
    </span>
  )
}

export default function Navbar ({ view, onView, isDark, onToggleTheme, onToggleSidebar }) {
  return (
    <header
      className="relative z-30 flex h-14 shrink-0 items-center gap-3 px-3 shadow-cb"
      style={{ background: 'var(--cb-header)', borderBottom: '1px solid var(--cb-header-border)' }}
    >
      <IconButton
        icon={TbMenu2}
        label="Toggle panels"
        tone="brand"
        onClick={onToggleSidebar}
        className="lg:hidden"
      />

      {/* Identity */}
      <div className="flex min-w-0 items-center gap-2.5">
        <img src={ndmaLogo} alt="NDMA" className="h-9 w-9 shrink-0 object-contain" />
        <div className="min-w-0 leading-tight">
          <h1 className="truncate text-[15px] font-bold tracking-tight text-cream">
            Convective Activity Risk System
          </h1>
          <p className="hidden truncate text-[11px] sm:block" style={{ color: 'var(--cb-header-text)' }}>
            National Disaster Management Authority
          </p>
        </div>
      </div>

      {/* View switch. Flat pills, active state is a solid fill. */}
      <nav className="ml-2 hidden items-center gap-1 rounded-cb-sm p-1 md:flex"
        style={{ background: 'rgba(255,255,255,0.08)' }}
      >
        {VIEWS.map((v) => {
          const Icon = v.icon
          const active = view === v.id
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => onView(v.id)}
              aria-current={active ? 'page' : undefined}
              className="flex cursor-pointer items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-150"
              style={
                active
                  ? { background: 'var(--cb-cream)', color: 'var(--cb-teal)' }
                  : { color: 'var(--cb-header-text)' }
              }
            >
              <Icon className="text-[15px]" aria-hidden />
              {v.label}
            </button>
          )
        })}
      </nav>

      <div className="flex-1" />

      <Clock />

      <span className="mx-1 hidden h-6 w-px sm:block" style={{ background: 'var(--cb-header-pill-border)' }} />

      <IconButton
        icon={isDark ? TbSun : TbMoon}
        label={isDark ? 'Switch to day theme' : 'Switch to night theme'}
        tone="brand"
        onClick={onToggleTheme}
      />
    </header>
  )
}
