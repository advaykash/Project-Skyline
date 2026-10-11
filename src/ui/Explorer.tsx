import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { HealthResponse } from '../../shared/contracts';
import {
  getState,
  setState,
  useStore,
  type CatalogState,
  type LayerVisibility,
} from '../state/store';
import { GlobeEngine } from '../globe/GlobeEngine';
import { loadEarthTextures } from '../globe/textures';
import { SearchPanel } from './SearchPanel';
import { Inspector } from './Inspector';
import { TimeBar } from './TimeBar';

export interface ExplorerProps {
  catalog: CatalogState | null;
  catalogLoading: boolean;
  catalogError: { message: string; hint?: string; code?: string } | null;
  health: HealthResponse | null;
  onGroupChange(group: string): void;
  onRetry(): void;
  onOpenSky(): void;
}

/**
 * The 3D explorer: globe, catalogue search, inspector and time controls.
 * Catalogue loading lives in the App shell so every route shares the data;
 * this component owns the WebGL engine lifecycle for its own mount.
 */
export function Explorer(props: ExplorerProps) {
  const { catalog, catalogLoading, catalogError, health, onGroupChange, onRetry, onOpenSky } = props;
  const selectedNoradId = useStore((s) => s.selectedNoradId);
  const searchQuery = useStore((s) => s.searchQuery);
  const layers = useStore((s) => s.layers);
  const followSelection = useStore((s) => s.followSelection);
  const webglFailed = useStore((s) => s.webglFailed);
  const leftOpen = useStore((s) => s.leftPanelOpen);
  const rightOpen = useStore((s) => s.rightPanelOpen);
  const replayPass = useStore((s) => s.replayPass);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GlobeEngine | null>(null);

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
            console.error('[Skyline] WebGL error:', message);
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

  // Catalogue -> engine. The shell loads catalogues for every route; the engine
  // only exists while this route is mounted, so each new catalogue is pushed
  // in (replacing the worker's propagators) whenever it arrives.
  useEffect(() => {
    if (catalog) engineRef.current?.setCatalog(catalog.records, catalog.group);
  }, [catalog]);

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

  const closeDrawers = useCallback(() => {
    setState({ leftPanelOpen: false, rightPanelOpen: false });
  }, []);

  const onResetView = useCallback(() => {
    engineRef.current?.resetCamera();
  }, []);

  return (
    <div className="explorer">
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
          <div className="row-actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onResetView}>
              Reset view
            </button>
          </div>
        </div>

        {replayPass ? (
          <div className="replay-banner" role="status">
            <span>
              Replaying a pass · peak {new Date(replayPass.peak.timeMs).toISOString().slice(11, 19)} UTC
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenSky}>
              Open sky view
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setState({ replayPass: null })}
            >
              Clear
            </button>
          </div>
        ) : null}

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
    </div>
  );
}
