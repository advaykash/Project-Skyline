import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { GpResponse, HealthResponse } from '../shared/contracts';
import { ApiRequestError, fetchCatalog, fetchHealth } from './data/api';
import {
  getState,
  pushToast,
  setState,
  useStore,
  type CatalogState,
  type LayerVisibility,
} from './state/store';
import { advance as advanceClock, claimPump, releasePump } from './state/clock';
import { GlobeEngine } from './globe/GlobeEngine';
import { loadEarthTextures } from './globe/textures';
import { Header } from './ui/Header';
import { SearchPanel } from './ui/SearchPanel';
import { Inspector } from './ui/Inspector';
import { TimeBar } from './ui/TimeBar';
import type { GpRecord } from './orbital/types';

const DEFAULT_GROUP = 'stations';
/** NORAD catalogue number of the ISS (ZARYA) — the object the app opens on. */
const ISS_NORAD_ID = 25544;

export function App() {
  const catalog = useStore((s) => s.catalog);
  const catalogLoading = useStore((s) => s.catalogLoading);
  const catalogError = useStore((s) => s.catalogError);
  const health = useStore((s) => s.health);
  const selectedNoradId = useStore((s) => s.selectedNoradId);
  const searchQuery = useStore((s) => s.searchQuery);
  const layers = useStore((s) => s.layers);
  const followSelection = useStore((s) => s.followSelection);
  const webglFailed = useStore((s) => s.webglFailed);
  const toasts = useStore((s) => s.toasts);
  const leftOpen = useStore((s) => s.leftPanelOpen);
  const rightOpen = useStore((s) => s.rightPanelOpen);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GlobeEngine | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Startup selection happens once, on the first catalogue that contains the ISS. */
  const autoSelectedRef = useRef(false);

  /* ------------------------------------------------------------ data load */

  const loadCatalogGroup = useCallback(async (group: string) => {
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
        // Open on the ISS: the station group is the default view, and having a
        // real object selected from the first frame makes the inspector,
        // orbit path and ground track immediately meaningful.
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
      engineRef.current?.setCatalog(next.records, next.group);
      if (response.state !== 'live') {
        pushToast(
          response.state === 'snapshot'
            ? `Offline snapshot in use — ${response.provenance.recordCount.toLocaleString('en-US')} genuine CelesTrak records, captured ${response.provenance.retrievedAt ?? 'unknown'}.`
            : `Serving ${response.state} CelesTrak data (${response.provenance.retrievedAt ?? 'unknown retrieval'}).`,
        );
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const apiError = error instanceof ApiRequestError ? error : null;
      setState({
        catalogLoading: false,
        catalogError: {
          message: apiError?.message ?? 'The catalogue could not be loaded.',
          hint: apiError?.hint,
          code: apiError?.code,
        },
      });
    }
  }, []);

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

  /* ------------------------------------------------------------- clock UI */

  // The clock subscription lives in <TimeBar>, which is the only component that
  // displays it: a tick repaints the footer instead of the whole shell.

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

  /* --------------------------------------------------------- engine wiring */

  useEffect(() => {
    const canvas = canvasRef.current;
    const labelLayer = labelLayerRef.current;
    if (!canvas || !labelLayer) return;

    let engine: GlobeEngine;
    try {
      engine = new GlobeEngine({
        canvas,
        labelLayer,
        callbacks: {
          onPick: (noradId) => {
            setState({ selectedNoradId: noradId, rightPanelOpen: noradId !== null || getState().rightPanelOpen });
          },
          onHover: (noradId) => setState({ hoveredNoradId: noradId }),
          onWebGLError: (message) => {
            console.error('[OrbitWatch] WebGL error:', message);
            setState({ webglFailed: true });
          },
          onWorkerStatus: () => {
            /* surfaced through the data panel when needed */
          },
        },
      });
    } catch {
      // No WebGL (or context creation failed): the UI falls back to list +
      // inspector mode and keeps the simulation clock running.
      setState({ webglFailed: true });
      return;
    }
    engineRef.current = engine;
    void engine.loadTextures(loadEarthTextures);

    const current = getState();
    engine.setLayers(current.layers);
    engine.setFollow(current.followSelection);
    if (current.catalog) engine.setCatalog(current.catalog.records, current.catalog.group);

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // Selection -> engine. The Inspector propagates the selected object for its
  // own readout, at its own cadence; the engine keeps the globe's copy of the
  // same state. Neither hands values to the other.
  useEffect(() => {
    engineRef.current?.setSelected(selectedNoradId);
  }, [selectedNoradId, catalog]);

  // Layers / follow -> engine
  useEffect(() => {
    engineRef.current?.setLayers(layers);
  }, [layers]);
  useEffect(() => {
    engineRef.current?.setFollow(followSelection);
  }, [followSelection]);

  /* --------------------------------------------------------------- actions */

  const onGroupChange = useCallback(
    (group: string) => {
      if (group === '') return;
      setState({ selectedNoradId: null, searchQuery: '', rightPanelOpen: false });
      void loadCatalogGroup(group);
    },
    [loadCatalogGroup],
  );

  const onSelect = useCallback((noradId: number) => {
    // On narrow screens the panels are drawers: reveal the inspector, not both.
    setState({ selectedNoradId: noradId, rightPanelOpen: true, leftPanelOpen: false });
    engineRef.current?.focusSelected();
  }, []);

  const onLayerToggle = useCallback((layer: keyof LayerVisibility) => {
    setState((s) => ({ layers: { ...s.layers, [layer]: !s.layers[layer] } }));
  }, []);

  const onQueryChange = useCallback((query: string) => {
    setState({ searchQuery: query });
  }, []);

  const onRetry = useCallback(() => {
    void loadCatalogGroup(getState().catalog?.group ?? DEFAULT_GROUP);
  }, [loadCatalogGroup]);

  const inspectorProps = useMemo(
    () => ({
      catalog,
      noradId: selectedNoradId,
      layers,
      followSelection,
      onFocus: () => engineRef.current?.focusSelected(),
      onFollowToggle: () => setState((s) => ({ followSelection: !s.followSelection })),
      onLayerToggle,
      onSelect,
    }),
    [catalog, selectedNoradId, layers, followSelection, onLayerToggle, onSelect],
  );

  // On narrow screens the two panels are drawers over the globe: only one may be
  // open at a time, and the backdrop below closes whichever is open.
  const openDrawer = useCallback((drawer: 'left' | 'right') => {
    setState((s) => {
      const open = drawer === 'left' ? s.leftPanelOpen : s.rightPanelOpen;
      return {
        leftPanelOpen: open ? false : drawer === 'left',
        rightPanelOpen: open ? false : drawer === 'right',
      };
    });
  }, []);

  const closeDrawers = useCallback(() => {
    setState({ leftPanelOpen: false, rightPanelOpen: false });
  }, []);

  return (
    <div className="app-shell">
      <Header
        onToggleLeft={() => openDrawer('left')}
        onToggleRight={() => openDrawer('right')}
      />

      {leftOpen || rightOpen ? (
        <div className="panel-backdrop" onClick={closeDrawers} aria-hidden="true" />
      ) : null}

      <aside className={`panel panel-left${leftOpen ? ' is-open' : ''}`} aria-label="Search and data sources">
        <div className="panel-drawer-bar">
          <span className="panel-drawer-title">Search &amp; sources</span>
          <button type="button" className="btn panel-close" onClick={closeDrawers} aria-label="Close search panel">
            Close
          </button>
        </div>
        <SearchPanel
          catalog={catalog}
          health={health}
          loading={catalogLoading}
          error={catalogError}
          query={searchQuery}
          selectedNoradId={selectedNoradId}
          onQueryChange={onQueryChange}
          onSelect={onSelect}
          onGroupChange={onGroupChange}
          onRetry={onRetry}
        />
      </aside>

      <main className="stage">
        <canvas ref={canvasRef} className="globe-canvas" aria-label="Interactive 3D Earth with satellite positions" />
        <div className="stage-overlay" ref={labelLayerRef} />

        {webglFailed ? (
          <div className="webgl-fallback" role="alert">
            <h2 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>3D view unavailable</h2>
            <p style={{ maxWidth: 460 }}>
              This browser or device could not start WebGL, so the globe cannot render. Every catalogue,
              search and inspector function still works — select an object from the list to inspect its real
              orbital elements and SGP4-derived position.
            </p>
          </div>
        ) : null}

        <div className="stage-legend-card">
          <div style={{ fontWeight: 650, color: 'var(--text-primary)' }}>Reading the globe</div>
          <div>Drag to rotate · scroll or pinch to zoom · click a marker to select · double-click to focus.</div>
          <div style={{ opacity: 0.85 }}>
            The terminator is the real day/night boundary for the simulation clock shown below.
          </div>
        </div>

        <div className="layer-toggles" role="group" aria-label="Globe layers">
          {(
            [
              ['orbits', 'Orbit path'],
              ['groundTracks', 'Ground track'],
              ['nightLights', 'Night lights'],
              ['clouds', 'Clouds'],
              ['atmosphere', 'Atmosphere'],
            ] as Array<[keyof LayerVisibility, string]>
          ).map(([key, label]) => (
            <label key={key} className="layer-toggle">
              <input type="checkbox" checked={layers[key]} onChange={() => onLayerToggle(key)} />
              {label}
            </label>
          ))}
        </div>
      </main>

      <aside className={`panel panel-right${rightOpen ? ' is-open' : ''}`} aria-label="Selected object inspector">
        <div className="panel-drawer-bar">
          <span className="panel-drawer-title">Inspector</span>
          <button type="button" className="btn panel-close" onClick={closeDrawers} aria-label="Close inspector panel">
            Close
          </button>
        </div>
        <Inspector {...inspectorProps} />
      </aside>

      <TimeBar catalog={catalog} layers={layers} />

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
