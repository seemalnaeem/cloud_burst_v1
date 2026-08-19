// The card for a clicked high-alert district.
//
// In the Analysis tab, clicking a district that is flashing under the current
// advisory shows this instead of the CARI score card. It names the district, its
// province, and the PMD release that put it under alert, with a link to the
// source. Analysis only; every other click keeps its usual card.

import { TbAlertTriangle, TbX, TbExternalLink } from 'react-icons/tb'

import { Panel, IconButton, Chip } from './ui/Panel'

const ALERT_RED = '#ef4444'

export default function AlertCard ({ selection, release, info, onClose }) {
  const props = selection?.properties ?? {}
  const name = info?.name ?? props.district_name ?? 'District'
  const province = info?.province ?? props.province

  return (
    <Panel
      title="High alert"
      icon={TbAlertTriangle}
      accent={ALERT_RED}
      className="w-[320px]"
      bodyClassName="px-3 py-3"
      actions={<IconButton icon={TbX} label="Close" size="sm" tone="ghost" onClick={onClose} />}
    >
      <div className="mb-3 flex items-start gap-2.5">
        <span
          className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full"
          style={{ background: ALERT_RED, boxShadow: '0 0 0 3px rgba(239,68,68,0.25)' }}
        />
        <div className="min-w-0">
          <h3 className="truncate text-[16px] font-semibold leading-tight text-text">{name}</h3>
          {province && <p className="mt-0.5 truncate text-[11.5px] text-muted">{province}</p>}
        </div>
      </div>

      <div className="rounded-cb-sm border border-danger-border bg-danger-soft px-3 py-2">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-danger">Rain / wind advisory</p>
        {release?.title && <p className="mt-1 text-[12px] leading-snug text-text-2">{release.title}</p>}
        {release?.date && <p className="mt-1.5 text-[11px] text-muted">Issued {release.date} · PMD</p>}
      </div>

      {release?.url && (
        <a
          href={release.url}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-cb-sm border border-border bg-panel-2 px-3 py-2 text-[12px] font-medium text-text-2 transition-colors hover:text-text"
        >
          <TbExternalLink className="text-[14px]" aria-hidden />
          Read the press release
        </a>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Chip color={ALERT_RED}>High alert</Chip>
        {props.district_code && <Chip>{props.district_code}</Chip>}
      </div>
    </Panel>
  )
}
