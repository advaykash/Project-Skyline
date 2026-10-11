import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  advance as advanceClock,
  claimPump,
  getRate,
  getTimeMs,
  resetToNow,
  releasePump,
  setRate,
  setTime as clockSetTime,
  subscribe as subscribeClock,
} from './state/clock';
import { GlobeEngine } from './globe/GlobeEngine';
import { loadEarthTextures } from './globe/textures';
import { buildSatrec, propagateState } from './orbital/elements';
import type { SatelliteState } from './orbital/types';
import { Header } from './ui/Header';
import { SearchPanel } from './ui/SearchPanel';
import { Inspector } from './ui/Inspector';
import { TimeBar } from './ui/TimeBar';
import type { GpRecord } from './orbital/types';

const DEFAULT_GROUP = 'stations';

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
  const [simTimeMs, setSimTimeMs] = useState(() => getTimeMs());
  const [rate, setRateState] = useState(() => getRate());
  const [liveState, setLiveState] = useState<{ state: SatelliteState | null; atMs: number }>({
    state: null,
    atMs: getTimeMs(),
  });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GlobeEngine | null>(null);
  const selectionSatrecRef = useRef<ReturnType<typeof buildSatrec> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
      setState((s) => ({
        catalog: next,
        catalogLoading: false,
        catalogError: null,
        selectedNoradId:
          s.selectedNoradId !== null &&
          next.records.some((r) => Number(r.NORAD_CAT_ID) === s.selectedNoradId)
            ? s.selectedNoradId
            : null,
      }));
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

  useEffect(() => {
    return subscribeClock((ms) => setSimTimeMs(ms));
  }, []);

  // Fallback clock pump when WebGL is unavailable (exactly one pump ever runs).
  useEffect(() => {
    if (!webglFailed) return;
    if (!claimPump('app-fallback')) return;
    const id = window.setInterval(() => {
      advanceClock(performance.now(), 'app-fallback');
      setSimTimeMs(getTimeMs());
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

  // Selection -> engine. (No setState here: the inspector's live-value
  // interval below refreshes within a quarter second, and the Inspector hides
  // live values entirely whenever nothing is selected.)
  useEffect(() => {
    engineRef.current?.setSelected(selectedNoradId);
    selectionSatrecRef.current = null;
    if (selectedNoradId === null || !getState().catalog) return;
    const record = getState().catalog?.records.find((r) => Number(r.NORAD_CAT_ID) === selectedNoradId);
    if (!record) return;
    try {
      selectionSatrecRef.current = buildSatrec(record);
    } catch {
      selectionSatrecRef.current = null;
    }
  }, [selectedNoradId, catalog]);

  // Inspector live values, at a calm cadence, always stamped with the exact
  // instant they were computed for (they use the same code path as the marker).
  useEffect(() => {
    const id = window.setInterval(() => {
      const satrec = selectionSatrecRef.current;
      const noradId = getState().selectedNoradId;
      if (!satrec || noradId === null) {
        setLiveState({ state: null, atMs: getTimeMs() });
        return;
      }
      const atMs = getTimeMs();
      setLiveState({ state: propagateState(satrec, noradId, new Date(atMs)), atMs });
    }, 250);
    return () => window.clearInterval(id);
  }, []);

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

  const onRateChange = useCallback((nextRate: number) => {
    setRate(nextRate);
    setRateState(nextRate);
  }, []);

  const onNow = useCallback(() => {
    resetToNow();
    setRateState(1);
    setSimTimeMs(getTimeMs());
  }, []);

  const onSeek = useCallback((deltaMs: number) => {
    const next = Math.min(Math.max(getTimeMs() + deltaMs, Date.now() - 7 * 86_400_000), Date.now() + 3 * 86_400_000);
    setSimTimeMs(next);
    // setTime is exported through the clock module's API surface:
    clockSetTime(next);
  }, []);

  const inspectorProps = useMemo(
    () => ({
      catalog,
      noradId: selectedNoradId,
      liveState: liveState.state,
      simTimeMs: liveState.atMs,
      layers,
      followSelection,
      onFocus: () => engineRef.current?.focusSelected(),
      onFollowToggle: () => setState((s) => ({ followSelection: !s.followSelection })),
      onLayerToggle,
      onSelect,
    }),
    [catalog, selectedNoradId, liveState, layers, followSelection, onLayerToggle, onSelect],
  );

  return (
    <div className="app-shell">
      <Header
        onToggleLeft={() => setState((s) => ({ leftPanelOpen: !s.leftPanelOpen }))}
        onToggleRight={() => setState((s) => ({ rightPanelOpen: !s.rightPanelOpen }))}
      />

      <aside className={`panel panel-left${leftOpen ? ' is-open' : ''}`} aria-label="Search and data sources">
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
        <Inspector {...inspectorProps} />
      </aside>

      <TimeBar
        simTimeMs={simTimeMs}
        rate={rate}
        catalog={catalog}
        layers={layers}
        onRateChange={onRateChange}
        onNow={onNow}
        onSeek={onSeek}
      />

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
