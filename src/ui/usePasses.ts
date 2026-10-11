/**
 * Shared pass-prediction hook for Orbit-to-Observer Replay.
 *
 * Computes upcoming passes for one object + observer over a configurable
 * window. The scan runs synchronously in a memo (a few thousand SGP4
 * evaluations, typically < 100 ms) and is keyed on object, observer and the
 * window start hour so observer edits invalidate it while clock ticks do not.
 */
import { useMemo } from 'react';
import type { SatRec } from 'satellite.js';
import { predictPasses, type ObserverLocation, type PredictedPass } from '../orbital/observer';

export interface PassWindow {
  startMs: number;
  endMs: number;
}

export function usePasses(
  satrec: SatRec | null,
  noradId: number | null,
  observer: ObserverLocation,
  windowHours: number,
  anchorMs: number,
): { passes: PredictedPass[]; window: PassWindow | null } {
  // Anchor the window to the hour so clock ticks don't retrigger the scan.
  const anchorHour = Math.floor(anchorMs / 3_600_000);
  return useMemo(() => {
    if (!satrec || noradId === null) return { passes: [], window: null };
    const startMs = anchorHour * 3_600_000;
    const endMs = startMs + windowHours * 3_600_000;
    const passes = predictPasses(satrec, noradId, observer, startMs, endMs, {
      minElevationDeg: 10,
      stepSeconds: 30,
      maxPasses: 12,
    });
    return { passes, window: { startMs, endMs } };
  }, [
    satrec,
    noradId,
    // The store replaces the observer object on every location change, so
    // identity here is equivalent to a by-value dependency.
    observer,
    windowHours,
    anchorHour,
  ]);
}
