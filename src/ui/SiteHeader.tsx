/**
 * Site header: Skyline branding, primary navigation, data-state chip and clock.
 * On the explorer route it also carries the mobile panel toggles.
 */
import { memo, useEffect, useState } from 'react';
import { useStore, type Route } from '../state/store';
import { ROUTES } from './routes';
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

export interface SiteHeaderProps {
  route: Route;
  onNavigate(route: Route): void;
  onToggleLeft?(): void;
  onToggleRight?(): void;
}

export const SiteHeader = memo(function SiteHeader(props: SiteHeaderProps) {
  const { route, onNavigate } = props;
  const now = useClock();
  const health = useStore((s) => s.health);
  const catalog = useStore((s) => s.catalog);
  const leftOpen = useStore((s) => s.leftPanelOpen);
  const rightOpen = useStore((s) => s.rightPanelOpen);
  const [menuOpen, setMenuOpen] = useState(false);

  const groupState = catalog?.state ?? 'unavailable';
  const navItems = ROUTES.filter((r) => r.id !== 'home');

  return (
    <header className="site-header">
      {props.onToggleLeft ? (
        <button
          type="button"
          className="btn btn-icon btn-ghost panel-toggle-mobile"
          aria-label={leftOpen ? 'Close search panel' : 'Open search panel'}
          aria-expanded={leftOpen}
          onClick={props.onToggleLeft}
        >
          <SearchIcon />
        </button>
      ) : null}

      <button type="button" className="brand brand-btn" onClick={() => onNavigate('home')} aria-label="Skyline home">
        <img src="/favicon.svg" alt="" className="brand-logo" width={30} height={30} />
        <span className="brand-text">
          <span className="brand-name">Skyline</span>
          <span className="brand-tagline">Everything moving above our world</span>
        </span>
      </button>

      <nav className={`site-nav${menuOpen ? ' is-open' : ''}`} aria-label="Primary">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-link${route === item.id ? ' is-active' : ''}`}
            aria-current={route === item.id ? 'page' : undefined}
            onClick={() => {
              setMenuOpen(false);
              onNavigate(item.id);
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

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
        className="btn btn-icon btn-ghost nav-menu-btn"
        aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <MenuIcon />
      </button>

      {props.onToggleRight ? (
        <button
          type="button"
          className="btn btn-icon btn-ghost panel-toggle-mobile"
          aria-label={rightOpen ? 'Close inspector panel' : 'Open inspector panel'}
          aria-expanded={rightOpen}
          onClick={props.onToggleRight}
        >
          <PanelIcon />
        </button>
      ) : null}
    </header>
  );
});

export const SiteFooter = memo(function SiteFooter({ onNavigate }: { onNavigate(route: Route): void }) {
  return (
    <footer className="site-footer">
      <span>
        <strong>Skyline</strong> · an educational visualization — not for space-safety decisions.
      </span>
      <span>
        Data: CelesTrak · NOAA · Open-Meteo ·{' '}
        <button type="button" className="link-btn" onClick={() => onNavigate('about')}>
          How it works &amp; credits
        </button>
      </span>
    </footer>
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

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4.5h12M2 8h12M2 11.5h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
