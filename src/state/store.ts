/**
 * A very small observable store (no external dependency).
 *
 * The React interface subscribes through `useSyncExternalStore`; the globe
 * engine and the propagation worker subscribe imperatively. Only values that
 * change are replaced, so selector results keep referential stability and the
 * globe never re-renders the React tree at animation rate.
 */
import { useSyncExternalStore } from 'react';
import type { CatalogProvenance, DataState, HealthResponse } from '../../shared/contracts';
import type { GpRecord } from '../orbital/types';

export interface CatalogState {
  group: string;
  records: GpRecord[];
  provenance: CatalogProvenance;
  state: DataState;
}

export interface LayerVisibility {
  orbits: boolean;
  groundTracks: boolean;
  labels: boolean;
  clouds: boolean;
  nightLights: boolean;
  atmosphere: boolean;
}

export interface AppState {
  health: HealthResponse | null;
  healthError: string | null;
  catalog: CatalogState | null;
  catalogLoading: boolean;
  catalogError: { message: string; hint?: string; code?: string } | null;
  selectedNoradId: number | null;
  hoveredNoradId: number | null;
  searchQuery: string;
  /** Simulation time shown by the globe, in ms since the Unix epoch. */
  simTimeMs: number;
  /** Playback rate: 1 = real time. */
  timeRate: number;
  layers: LayerVisibility;
  followSelection: boolean;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  toasts: Array<{ id: number; text: string }>;
  /** Set when the WebGL context could not be created. */
  webglFailed: boolean;
}

const initialLayers: LayerVisibility = {
  orbits: true,
  groundTracks: true,
  labels: true,
  clouds: true,
  nightLights: true,
  atmosphere: true,
};

let state: AppState = {
  health: null,
  healthError: null,
  catalog: null,
  catalogLoading: false,
  catalogError: null,
  selectedNoradId: null,
  hoveredNoradId: null,
  searchQuery: '',
  simTimeMs: Date.now(),
  timeRate: 1,
  layers: initialLayers,
  followSelection: false,
  leftPanelOpen: false,
  rightPanelOpen: false,
  toasts: [],
  webglFailed: false,
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((current: AppState) => Partial<AppState>)): void {
  const update = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...update };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to a derived slice. The selector must return stable values. */
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

let toastId = 0;

export function pushToast(text: string, ttlMs = 5200): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, text }] }));
  window.setTimeout(() => {
    setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }, ttlMs);
}

/** Reset helper used by end-to-end tests. */
export function resetStore(): void {
  state = {
    ...state,
    selectedNoradId: null,
    hoveredNoradId: null,
    searchQuery: '',
    simTimeMs: Date.now(),
    timeRate: 1,
    layers: initialLayers,
    followSelection: false,
    toasts: [],
    webglFailed: false,
  };
  for (const listener of listeners) listener();
}
