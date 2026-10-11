/**
 * Skyline application shell: routing, shared catalogue loading and layout.
 *
 * The catalogue, selection, observer, replay pass and simulation clock are
 * owned here (in the store) and shared by every route, so the globe, the
 * inspector, the sky chart and the pass list can never disagree about which
 * object, location or instant they describe.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { GpResponse, HealthResponse } from '../shared/contracts';
import { ApiRequestError, fetchCatalog, fetchHealth } from './data/api';
import {
  getState,
  pushToast,
  setState,
  useStore,
  type CatalogState,
  type Route,
} from './state/store';
import { advance as advanceClock, claimPump, releasePump } from './state/clock';
import { loadStoredObserver } from './state/observer';
import type { GpRecord } from './orbital/types';
import { Explorer } from './ui/Explorer';
import { HomeView } from './ui/HomeView';
import { SkyView } from './ui/SkyView';
import { WeatherView } from './ui/WeatherView';
import { EventsView } from './ui/EventsView';
import { AboutView } from './ui/AboutView';
import { SiteFooter, SiteHeader } from './ui/SiteHeader';
import { hashForRoute, navigate, routeFromHash } from './ui/routes';

const DEFAULT_GROUP = 'stations';
/** NORAD catalogue number of the ISS (ZARYA). */
const ISS_NORAD_ID = 25544;

export function App() {
  const route = useStore((s) => s.route);
  const catalog = useStore((s) => s.catalog);
  const catalogLoading = useStore((s) => s.catalogLoading);
  const catalogError = useStore((s) => s.catalogError);
  const health = useStore((s) => s.health);
  const webglFailed = useStore((s) => s.webglFailed);
  const toasts = useStore((s) => s.toasts);

  const abortRef = useRef<AbortController | null>(null);
  const autoSelectedRef = useRef(false);

  /* ------------------------------------------------------------ data load */

  const loadCatalogGroup = useCallback(async (group: string): Promise<CatalogState | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ catalogLoading: true, catalogError: null });
    try {
      const response: GpResponse = await fetchCatalog(group, controller.signal);
      const next: CatalogState = {
        group: response.group,
        records: response.records as GpRecord[],
        provenance: response.provenance,
        state: response.state,
      };
      setState((s) => {
        const keepsSelection =
          s.selectedNoradId !== null &&
          next.records.some((r) => Number(r.NORAD_CAT_ID) === s.selectedNoradId);
        const autoSelect =
          !keepsSelection &&
          !autoSelectedRef.current &&
          next.records.some((r) => Number(r.NORAD_CAT_ID) === ISS_NORAD_ID);
        if (autoSelect) autoSelectedRef.current = true;
        return {
          catalog: next,
          catalogLoading: false,
          catalogError: null,
          selectedNoradId: keepsSelection ? s.selectedNoradId : autoSelect ? ISS_NORAD_ID : null,
        };
      });
      if (response.state !== 'live') {
        pushToast(
          response.state === 'snapshot'
            ? `Offline snapshot in use — ${response.provenance.recordCount.toLocaleString('en-US')} genuine CelesTrak records, captured ${response.provenance.retrievedAt ?? 'unknown'}.`
            : `Serving ${response.state} CelesTrak data (${response.provenance.retrievedAt ?? 'unknown retrieval'}).`,
        );
      }
      return next;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      const apiError = error instanceof ApiRequestError ? error : null;
      setState({
        catalogLoading: false,
        catalogError: {
          message: apiError?.message ?? 'The catalogue could not be loaded.',
          hint: apiError?.hint,
          code: apiError?.code,
        },
      });
      return null;
    }
  }, []);

  // Initial route from the URL hash, kept in sync afterwards.
  useEffect(() => {
    setState({ route: routeFromHash(window.location.hash), observer: loadStoredObserver() });
    const onHashChange = () => {
      setState({ route: routeFromHash(window.location.hash), leftPanelOpen: false, rightPanelOpen: false });
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Keep the hash in sync when navigation happens programmatically.
  const onNavigate = useCallback(
    (next: Route) => {
      if (getState().route === next && window.location.hash === hashForRoute(next)) return;
      setState({ route: next, leftPanelOpen: false, rightPanelOpen: false });
      window.scrollTo({ top: 0 });
      if (window.location.hash !== hashForRoute(next)) navigate(next);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response: HealthResponse = await fetchHealth();
        if (!cancelled) setState({ health: response, healthError: null });
      } catch (error) {
        if (!cancelled) {
          setState({ healthError: error instanceof Error ? error.message : 'Health check failed' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void loadCatalogGroup(getState().catalog?.group ?? DEFAULT_GROUP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fallback clock pump when WebGL is unavailable (exactly one pump ever runs).
  useEffect(() => {
    if (!webglFailed) return;
    if (!claimPump('app-fallback')) return;
    const id = window.setInterval(() => {
      advanceClock(performance.now(), 'app-fallback');
    }, 100);
    return () => {
      window.clearInterval(id);
      releasePump('app-fallback');
    };
  }, [webglFailed]);

  /* ------------------------------------------------------------- navigation */

  const onGroupChange = useCallback(
    (group: string) => {
      if (group === '') return;
      setState({ selectedNoradId: null, searchQuery: '', rightPanelOpen: false, replayPass: null });
      void loadCatalogGroup(group);
    },
    [loadCatalogGroup],
  );

  const onRetry = useCallback(() => {
    void loadCatalogGroup(getState().catalog?.group ?? DEFAULT_GROUP);
  }, [loadCatalogGroup]);

  const ensureIssSelected = useCallback(async (): Promise<boolean> => {
    const current = getState().catalog;
    if (current?.records.some((r) => Number(r.NORAD_CAT_ID) === ISS_NORAD_ID)) {
      setState({ selectedNoradId: ISS_NORAD_ID });
      return true;
    }
    const next = await loadCatalogGroup('stations');
    if (next?.records.some((r) => Number(r.NORAD_CAT_ID) === ISS_NORAD_ID)) {
      setState({ selectedNoradId: ISS_NORAD_ID, searchQuery: '' });
      return true;
    }
    pushToast('The ISS is not in the loaded catalogue right now — showing the explorer instead.');
    return false;
  }, [loadCatalogGroup]);

  const onTrackIss = useCallback(() => {
    onNavigate('explorer');
    void ensureIssSelected().then((ok) => {
      if (ok) setState({ rightPanelOpen: true });
    });
  }, [onNavigate, ensureIssSelected]);

  const onExploreGroup = useCallback(
    (group: string, label: string) => {
      onNavigate('explorer');
      pushToast(`Loading ${label}…`);
      onGroupChange(group);
    },
    [onNavigate, onGroupChange],
  );

  const openDrawer = useCallback((drawer: 'left' | 'right') => {
    setState((s) => {
      const open = drawer === 'left' ? s.leftPanelOpen : s.rightPanelOpen;
      return {
        leftPanelOpen: open ? false : drawer === 'left',
        rightPanelOpen: open ? false : drawer === 'right',
      };
    });
  }, []);

  const isExplorer = route === 'explorer';

  return (
    <div className={`app-shell${isExplorer ? ' app-shell-explorer' : ''}`}>
      <SiteHeader
        route={route}
        onNavigate={onNavigate}
        onToggleLeft={isExplorer ? () => openDrawer('left') : undefined}
        onToggleRight={isExplorer ? () => openDrawer('right') : undefined}
      />

      {route === 'home' ? (
        <main className="content">
          <HomeView
            onExplore={() => onNavigate('explorer')}
            onTrackIss={onTrackIss}
            onNavigate={onNavigate}
          />
        </main>
      ) : null}

      {isExplorer ? (
        <Explorer
          catalog={catalog}
          catalogLoading={catalogLoading}
          catalogError={catalogError}
          health={health}
          onGroupChange={onGroupChange}
          onRetry={onRetry}
          onOpenSky={() => onNavigate('sky')}
        />
      ) : null}

      {route === 'sky' ? (
        <main className="content">
          <SkyView
            catalog={catalog}
            catalogLoading={catalogLoading}
            onOpenExplorer={() => onNavigate('explorer')}
            onTrackIss={onTrackIss}
          />
        </main>
      ) : null}

      {route === 'weather' ? (
        <main className="content">
          <WeatherView />
        </main>
      ) : null}

      {route === 'events' ? (
        <main className="content">
          <EventsView onExploreGroup={onExploreGroup} />
        </main>
      ) : null}

      {route === 'about' ? (
        <main className="content">
          <AboutView />
        </main>
      ) : null}

      {!isExplorer ? <SiteFooter onNavigate={onNavigate} /> : null}

      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}
