/**
 * The simulation clock — the single source of truth for "what time is it?".
 *
 * The globe engine advances it once per rendered frame and renders every
 * position at exactly `getTimeMs()`. The interface mirrors the same value at a
 * throttled rate, so the globe, the markers, the orbit path and the displayed
 * timestamps always refer to the same instant.
 *
 * Exactly one owner may call `advance()`: the engine's animation loop when WebGL
 * is running, otherwise the interface's fallback timer. This is enforced by the
 * `pump` handshake below.
 */
export type ClockListener = (simTimeMs: number) => void;

const listeners = new Set<ClockListener>();
const notifiedListeners = new Set<ClockListener>();

let simTimeMs = Date.now();
let rate = 1;
let lastWallMs: number | null = null;
let pumpOwner: string | null = null;
let lastNotifyMs = 0;

export function getTimeMs(): number {
  return simTimeMs;
}

export function getRate(): number {
  return rate;
}

/**
 * Register the clock pump. Returns true when ownership was granted. Only one
 * owner exists at a time — this prevents double-advancing the clock.
 */
export function claimPump(owner: string): boolean {
  if (pumpOwner !== null && pumpOwner !== owner) return false;
  pumpOwner = owner;
  lastWallMs = null;
  return true;
}

export function releasePump(owner: string): void {
  if (pumpOwner === owner) {
    pumpOwner = null;
    lastWallMs = null;
  }
}

/** Advance the clock from wall time. Only the pump owner should call this. */
export function advance(wallMs: number, owner: string, notifyIntervalMs = 100): void {
  if (pumpOwner !== owner) return;
  if (lastWallMs === null) {
    lastWallMs = wallMs;
    return;
  }
  const deltaWall = Math.min(Math.max(wallMs - lastWallMs, 0), 250); // clamp big tab gaps
  lastWallMs = wallMs;
  simTimeMs += deltaWall * rate;

  if (wallMs - lastNotifyMs >= notifyIntervalMs) {
    lastNotifyMs = wallMs;
    for (const listener of listeners) listener(simTimeMs);
  }
}

/** Set simulation time and/or playback rate (used by the interface). */
export function setTime(nextMs: number, nextRate?: number): void {
  simTimeMs = nextMs;
  lastWallMs = null;
  if (nextRate !== undefined) rate = nextRate;
  for (const listener of listeners) listener(simTimeMs);
}

export function setRate(nextRate: number): void {
  rate = nextRate;
  lastWallMs = null;
}

/** Return to real time and set the rate to 1. */
export function resetToNow(): void {
  simTimeMs = Date.now();
  rate = 1;
  lastWallMs = null;
  for (const listener of listeners) listener(simTimeMs);
}

export function subscribe(listener: ClockListener): () => void {
  listeners.add(listener);
  notifiedListeners.add(listener);
  return () => {
    listeners.delete(listener);
    notifiedListeners.delete(listener);
  };
}

/** Test/reset helper. */
export function resetClock(ownerName: string | null = null): void {
  simTimeMs = Date.now();
  rate = 1;
  lastWallMs = null;
  pumpOwner = ownerName;
  lastNotifyMs = 0;
}
