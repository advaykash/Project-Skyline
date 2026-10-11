/**
 * SGP4 propagation worker.
 *
 * Catalogue propagation runs off the main thread so the interface stays at
 * frame rate even for 16,000-object catalogues. The worker owns the SGP4
 * propagators and streams scene-space positions back as a Float32Array.
 *
 * Protocol (structured clone; the position buffer is transferred):
 *   main -> worker : { type: 'catalog', id, records }
 *                    { type: 'tick', id, timeMs }
 *   worker -> main : { type: 'ready', id, count, failures }
 *                    { type: 'positions', id, timeMs, positions, durationMs }
 *                    { type: 'error', message }
 */
/// <reference lib="webworker" />
import type { SatRec } from 'satellite.js';
import { buildSatrec, propagateScenePosition, type GpRecord } from '../orbital/elements';
import { gmstFor } from '../orbital/frames';

interface CatalogMessage {
  type: 'catalog';
  id: number;
  records: GpRecord[];
}

interface TickMessage {
  type: 'tick';
  id: number;
  timeMs: number;
}

type Incoming = CatalogMessage | TickMessage;

interface Failure {
  index: number;
  noradId: number;
  reason: string;
}

let satrecs: Array<SatRec | null> = [];
let noradIds: number[] = [];
let objectCount = 0;

function loadCatalog(records: GpRecord[]): { count: number; failures: Failure[] } {
  satrecs = new Array(records.length).fill(null);
  noradIds = new Array(records.length).fill(0);
  const failures: Failure[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    try {
      satrecs[i] = buildSatrec(record);
      noradIds[i] = Number(record.NORAD_CAT_ID) || 0;
    } catch (err) {
      failures.push({
        index: i,
        noradId: Number(record.NORAD_CAT_ID) || 0,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  objectCount = records.length;
  return { count: records.length, failures };
}

function tick(timeMs: number): { positions: Float32Array; durationMs: number } {
  const started = performance.now();
  const date = new Date(timeMs);
  const gmst = gmstFor(date);
  const positions = new Float32Array(objectCount * 3);

  for (let i = 0; i < objectCount; i += 1) {
    const satrec = satrecs[i];
    if (!satrec) {
      positions[i * 3] = Number.NaN;
      positions[i * 3 + 1] = Number.NaN;
      positions[i * 3 + 2] = Number.NaN;
      continue;
    }
    const scene = propagateScenePosition(satrec, date, gmst);
    if (scene) {
      positions[i * 3] = scene.x;
      positions[i * 3 + 1] = scene.y;
      positions[i * 3 + 2] = scene.z;
    } else {
      positions[i * 3] = Number.NaN;
      positions[i * 3 + 1] = Number.NaN;
      positions[i * 3 + 2] = Number.NaN;
    }
  }
  return { positions, durationMs: performance.now() - started };
}

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<Incoming>) => void): void;
};

scope.addEventListener('message', (event) => {
  const message = event.data;
  try {
    if (message.type === 'catalog') {
      const { count, failures } = loadCatalog(message.records);
      scope.postMessage({ type: 'ready', id: message.id, count, failures });
      return;
    }
    if (message.type === 'tick') {
      const { positions, durationMs } = tick(message.timeMs);
      scope.postMessage(
        { type: 'positions', id: message.id, timeMs: message.timeMs, positions, durationMs },
        [positions.buffer],
      );
    }
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
});

export type { Incoming as PropagatorIncomingMessage };
