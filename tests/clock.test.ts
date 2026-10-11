/**
 * Tests for the simulation clock: single-pump ownership, rate scaling,
 * tab-gap clamping, live/pause/simulated transitions and notification.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advance,
  claimPump,
  getRate,
  getTimeMs,
  releasePump,
  resetClock,
  resetToNow,
  setRate,
  setTime,
  subscribe,
} from '../src/state/clock';

beforeEach(() => {
  resetClock(null);
  vi.useRealTimers();
});

describe('pump ownership', () => {
  it('grants exactly one owner at a time', () => {
    expect(claimPump('globe')).toBe(true);
    expect(claimPump('fallback')).toBe(false);
    releasePump('globe');
    expect(claimPump('fallback')).toBe(true);
    releasePump('fallback');
  });

  it('ignores advance calls from non-owners', () => {
    claimPump('globe');
    const before = getTimeMs();
    advance(before + 10_000, 'intruder');
    expect(getTimeMs()).toBe(before);
    releasePump('globe');
  });
});

describe('advance', () => {
  it('scales wall time by the playback rate', () => {
    claimPump('t');
    setRate(60);
    advance(1_000, 't');
    const t0 = getTimeMs();
    advance(1_100, 't'); // 100 ms wall (inside the 250 ms clamp) × 60
    expect(getTimeMs() - t0).toBe(6_000);
    releasePump('t');
  });

  it('freezes simulation time at rate 0 (pause)', () => {
    claimPump('t');
    setRate(0);
    advance(1_000, 't');
    const t0 = getTimeMs();
    advance(2_000, 't');
    expect(getTimeMs()).toBe(t0);
    releasePump('t');
  });

  it('clamps large tab gaps instead of jumping', () => {
    claimPump('t');
    setRate(1);
    advance(1_000, 't');
    const t0 = getTimeMs();
    advance(1_000 + 3_600_000, 't'); // one hour in the background
    expect(getTimeMs() - t0).toBeLessThanOrEqual(250);
    releasePump('t');
  });

  it('notifies subscribers on a throttled cadence', () => {
    claimPump('t');
    const seen: number[] = [];
    const unsubscribe = subscribe((ms) => seen.push(ms));
    for (let w = 1_000; w <= 5_000; w += 50) advance(w, 't', 100);
    unsubscribe();
    releasePump('t');
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
});

describe('transitions', () => {
  it('setTime seeks without changing the rate unless asked', () => {
    setRate(60);
    setTime(1_700_000_000_000);
    expect(getTimeMs()).toBe(1_700_000_000_000);
    expect(getRate()).toBe(60);
    setTime(1_700_000_000_000, 1);
    expect(getRate()).toBe(1);
  });

  it('resetToNow returns to wall time at 1x', () => {
    setTime(1_000_000_000_000, 600);
    resetToNow();
    expect(getRate()).toBe(1);
    expect(Math.abs(getTimeMs() - Date.now())).toBeLessThan(5_000);
  });
});
