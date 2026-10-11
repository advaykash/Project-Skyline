import { memo, useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { StateChip } from './StateChip';
import { formatUtc } from './format';

function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export const Header = memo(function Header({ onToggleLeft, onToggleRight }: { onToggleLeft: () => void; onToggleRight: () => void }) {
  const now = useClock();
  const health = useStore((s) => s.health);
  const catalog = useStore((s) => s.catalog);
  const leftOpen = useStore((s) => s.leftPanelOpen);
  const rightOpen = useStore((s) => s.rightPanelOpen);

  const groupState = catalog?.state ?? 'unavailable';

  return (
    <header className="app-header">
      <button
        type="button"
        className="btn btn-icon btn-ghost panel-toggle-mobile"
        aria-label={leftOpen ? 'Close search panel' : 'Open search panel'}
        aria-expanded={leftOpen}
        onClick={onToggleLeft}
      >
        <SearchIcon />
      </button>

      <div className="brand">
        <img src="/favicon.svg" alt="" className="brand-logo" width={30} height={30} />
        <div>
          <div className="brand-name">
            Orbit<em>Watch</em>
          </div>
        </div>
        <div className="brand-tagline">Satellite tracking · CelesTrak GP · SGP4</div>
      </div>

      <div className="header-spacer" />

      <StateChip state={groupState} />
      {catalog?.provenance.degraded && catalog.state !== 'snapshot' ? (
        <span className="header-degraded">
          <StateChip state="degraded" size="sm" title={catalog.provenance.note} />
        </span>
      ) : null}

      <div className="clock-block">
        <span className="clock-value">{formatUtc(now)} UTC</span>
        <span className="clock-caption">
          {health ? `${health.groups.length} groups · ${health.provider}` : 'connecting…'}
        </span>
      </div>

      <button
        type="button"
        className="btn btn-icon btn-ghost panel-toggle-mobile"
        aria-label={rightOpen ? 'Close inspector panel' : 'Open inspector panel'}
        aria-expanded={rightOpen}
        onClick={onToggleRight}
      >
        <PanelIcon />
      </button>
    </header>
  );
});

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 2.5v11" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
