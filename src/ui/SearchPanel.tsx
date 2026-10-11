import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { GroupStatus, HealthResponse } from '../../shared/contracts';
import type { CatalogState } from '../state/store';
import { StateChip } from './StateChip';
import { formatAge, stateLabel } from './format';
import { CATEGORY_COLORS } from '../globe/satellitePoints';
import { useNow } from './useNow';

export interface SearchPanelProps {
  catalog: CatalogState | null;
  health: HealthResponse | null;
  loading: boolean;
  error: { message: string; hint?: string } | null;
  query: string;
  selectedNoradId: number | null;
  onQueryChange(query: string): void;
  onSelect(noradId: number): void;
  onGroupChange(group: string): void;
  onRetry(): void;
}

interface ResultEntry {
  noradId: number;
  name: string;
  objectId: string;
}

/** Category colour dot, matching the globe palette. */
function MarkerDot({ category }: { category: string }) {
  const color = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.catalog;
  return <span className="result-marker" style={{ background: `#${color.toString(16).padStart(6, '0')}` }} aria-hidden="true" />;
}

export const SearchPanel = memo(function SearchPanel(props: SearchPanelProps) {
  const { catalog, health, loading, error, query, selectedNoradId } = props;
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [activeIndex, setActiveIndex] = useState(0);
  const now = useNow();
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce filtering so typing stays smooth on 16k-record catalogues.
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query), 120);
    return () => window.clearTimeout(id);
  }, [query]);

  const results = useMemo<ResultEntry[]>(() => {
    if (!catalog) return [];
    const needle = debouncedQuery.trim().toLowerCase();
    const records = catalog.records;
    const out: ResultEntry[] = [];
    const numericNeedle = needle !== '' && /^\d+$/.test(needle) ? needle : null;

    for (let i = 0; i < records.length && out.length < 400; i += 1) {
      const record = records[i];
      const name = String(record.OBJECT_NAME ?? '').trim();
      const noradId = Number(record.NORAD_CAT_ID);
      if (needle === '') {
        out.push({ noradId, name, objectId: String(record.OBJECT_ID ?? '') });
        continue;
      }
      const nameMatch = name.toLowerCase().includes(needle);
      const idMatch = numericNeedle !== null && String(noradId).startsWith(numericNeedle);
      const objectMatch = String(record.OBJECT_ID ?? '')
        .toLowerCase()
        .includes(needle);
      if (nameMatch || idMatch || objectMatch) {
        out.push({ noradId, name, objectId: String(record.OBJECT_ID ?? '') });
      }
    }
    return out;
  }, [catalog, debouncedQuery]);

  // Adjust the highlight during render when the result set changes — the
  // React-recommended pattern (no effect, no cascading render).
  const resultKey = `${catalog?.group ?? ''}:${debouncedQuery}`;
  const [lastResultKey, setLastResultKey] = useState(resultKey);
  if (lastResultKey !== resultKey) {
    setLastResultKey(resultKey);
    setActiveIndex(0);
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => {
        const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
        return Math.min(Math.max(next, 0), Math.max(results.length - 1, 0));
      });
    } else if (event.key === 'Enter') {
      const entry = results[activeIndex];
      if (entry) {
        event.preventDefault();
        props.onSelect(entry.noradId);
      }
    } else if (event.key === 'Escape') {
      props.onQueryChange('');
    }
  };

  useEffect(() => {
    const active = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const groups: GroupStatus[] = health?.groups ?? [];
  const activeGroup = catalog?.group ?? '';

  return (
    <div className="panel-scroll" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <section className="panel-section">
        <h2 className="section-label">Catalogue</h2>
        <label className="sr-only" htmlFor="group-select">
          Satellite catalogue group
        </label>
        <select
          id="group-select"
          className="group-select"
          value={activeGroup}
          disabled={loading && !catalog}
          onChange={(event) => props.onGroupChange(event.target.value)}
        >
          {groups.length === 0 && activeGroup === '' ? (
            <option value="">Loading groups…</option>
          ) : (
            groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.label}
                {group.recordCount !== null ? ` · ${group.recordCount.toLocaleString('en-US')}` : ''}
              </option>
            ))
          )}
        </select>
        <p className="section-hint" style={{ minHeight: 32 }}>
          {groups.find((g) => g.id === activeGroup)?.description ??
            'Genuine CelesTrak General Perturbations data.'}
        </p>

        <div className="search-box" style={{ marginTop: 'var(--space-3)' }}>
          <span className="search-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </span>
          <label className="sr-only" htmlFor="satellite-search">
            Search satellites by name or NORAD catalogue ID
          </label>
          <input
            id="satellite-search"
            ref={inputRef}
            className="search-input"
            type="search"
            placeholder="Search name or NORAD ID…"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => props.onQueryChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {query !== '' ? (
            <button
              type="button"
              className="btn btn-icon btn-ghost search-clear"
              aria-label="Clear search"
              onClick={() => {
                props.onQueryChange('');
                inputRef.current?.focus();
              }}
            >
              ×
            </button>
          ) : null}
        </div>

        <div className="result-summary">
          <span aria-live="polite">
            {loading && !catalog
              ? 'Loading catalogue…'
              : catalog
                ? `${results.length.toLocaleString('en-US')} of ${catalog.records.length.toLocaleString('en-US')} objects`
                : 'No catalogue loaded'}
          </span>
          {catalog ? <StateChip state={catalog.state} size="sm" /> : null}
        </div>

        {error ? (
          <div className="banner banner-error" role="alert">
            <div className="banner-content">
              <div className="banner-title">Catalogue unavailable</div>
              <div>{error.message}</div>
              {error.hint ? <div className="field-note">{error.hint}</div> : null}
            </div>
            <div className="banner-actions">
              <button type="button" className="btn" onClick={props.onRetry}>
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {catalog && results.length === 0 ? (
          <div className="empty-state">
            <strong>No objects match “{debouncedQuery}”.</strong>
            Search covers every record in the loaded catalogue — names, NORAD
            catalogue IDs and international designators. Clear the field to see
            all {catalog.records.length.toLocaleString('en-US')} objects.
          </div>
        ) : (
          <ul
            className="result-list"
            ref={listRef}
            role="listbox"
            aria-label="Satellite search results"
            style={{ marginTop: 'var(--space-2)' }}
          >
            {results.map((entry, index) => (
              <li key={`${entry.noradId}-${index}`} role="option" aria-selected={entry.noradId === selectedNoradId}>
                <button
                  type="button"
                  className={`result-item${index === activeIndex ? ' is-active' : ''}`}
                  onClick={() => props.onSelect(entry.noradId)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <MarkerDot category={groups.find((g) => g.id === activeGroup)?.category ?? 'catalog'} />
                  <span className="result-body">
                    <span className="result-name">{entry.name}</span>
                    <span className="result-meta">
                      NORAD {entry.noradId}
                      {entry.objectId ? ` · ${entry.objectId}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel-section">
        <h2 className="section-label">Data &amp; sources</h2>
        {health ? (
          <DataHealthTable health={health} now={now} />
        ) : (
          <div className="empty-state" style={{ padding: 'var(--space-3)' }}>
            Source status will appear here once the API responds.
          </div>
        )}
      </section>
    </div>
  );
});

function DataHealthTable({ health, now }: { health: HealthResponse; now: number }) {
  return (
    <>
      <table className="data-table">
        <tbody>
          <tr>
            <th scope="row">Provider</th>
            <td>
              <a href="https://celestrak.org" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-strong)' }}>
                CelesTrak
              </a>
            </td>
          </tr>
          <tr>
            <th scope="row">Freshness policy</th>
            <td>
              live ≤ {(health.freshness.liveMs / 3_600_000).toFixed(0)} h
              <span className="unit">cached ≤ {(health.freshness.cachedMs / 86_400_000).toFixed(0)} d</span>
            </td>
          </tr>
          <tr>
            <th scope="row">Upstream</th>
            <td className="cell-wrap">
              {health.upstream.disabled ? 'disabled by configuration' : health.upstream.lastError ? (
                <span style={{ color: 'var(--state-stale)' }} title={health.upstream.lastError}>
                  {health.upstream.lastError.length > 64
                    ? `${health.upstream.lastError.slice(0, 64)}…`
                    : health.upstream.lastError}
                </span>
              ) : (
                health.upstream.lastSuccessAt
                  ? `last success ${formatAge((now - Date.parse(health.upstream.lastSuccessAt)) / 1000)}`
                : 'not attempted yet'
              )}
            </td>
          </tr>
          <tr>
            <th scope="row">Offline snapshot</th>
            <td>
              {health.snapshot.generatedAt
                ? formatAge((now - Date.parse(health.snapshot.generatedAt)) / 1000)
                : 'none'}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="divider-label">Catalogue groups</div>
      <table className="data-table">
        <tbody>
          {health.groups.map((group) => (
            <tr key={group.id}>
              <th scope="row" style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' }} title={group.label}>
                {group.label}
              </th>
              <td>
                <StateChip state={group.state} size="sm" title={group.note} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="field-note">
        States are computed from actual retrieval metadata: <strong>Live</strong> means CelesTrak was fetched within the
        freshness window, <strong>Snapshot</strong> means the bundled offline dataset (capture times listed above).
        {health.groups.some((g) => g.state === 'unavailable') ? (
          <> Greyed-out groups need live CelesTrak connectivity.</>
        ) : null}
      </p>
      <p className="field-note">
        Epoch coverage:{' '}
        {health.groups
          .filter((g) => g.epochRange)
          .slice(0, 3)
          .map((g) => `${g.label} ${stateLabel(g.state)} · ${g.epochRange?.min.slice(0, 10)} → ${g.epochRange?.max.slice(0, 10)}`)
          .join(' · ') || '—'}
      </p>
    </>
  );
}
