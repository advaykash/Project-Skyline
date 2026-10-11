import { useCallback, useEffect, useState } from 'react';
import type { CatalogState, LayerVisibility } from '../state/store';
import { CATEGORY_COLORS } from '../globe/satellitePoints';
import {
  getRate,
  getTimeMs,
  resetToNow,
  setRate,
  setTime,
  subscribe as subscribeClock,
} from '../state/clock';
import { formatUtc } from './format';

export interface TimeBarProps {
  catalog: CatalogState | null;
  layers: LayerVisibility;
}

const RATES = [1, 60, 300, 1800, 7200];
/** How far the −30m/+30m buttons move the simulation clock. */
const SEEK_STEP_MS = 30 * 60_000;

/**
 * The simulation clock readout and controls.
 *
 * The bar subscribes to the clock itself and owns the playback rate, so a clock
 * notification repaints this footer alone instead of re-rendering the whole
 * application shell (globe, panels, search results) several times per second.
 */
export function TimeBar(props: TimeBarProps) {
  const [simTimeMs, setSimTimeMs] = useState(() => getTimeMs());
  const [rate, setRateState] = useState(() => getRate());

  useEffect(() => {
    // `subscribe` returns its own unsubscribe function — handing it straight
    // back to React keeps one listener for the lifetime of the bar.
    return subscribeClock((ms) => setSimTimeMs(ms));
  }, []);

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
    const next = Math.min(
      Math.max(getTimeMs() + deltaMs, Date.now() - 7 * 86_400_000),
      Date.now() + 3 * 86_400_000,
    );
    setTime(next);
    setSimTimeMs(next);
  }, []);

  const category = props.catalog ? categoryKey(props.catalog.group) : 'catalog';
  const color = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.catalog;

  return (
    <footer className="timebar">
      <div className="time-readout">
        <span className="time-value">{formatUtc(simTimeMs)} UTC</span>
        <span className="time-caption">
          {rate === 1 ? 'simulation time · real time' : `simulation time · ${rate.toLocaleString('en-US')}× speed`}
        </span>
      </div>

      <div className="rate-group" role="group" aria-label="Simulation speed">
        {RATES.map((value) => (
          <button
            key={value}
            type="button"
            className="rate-btn"
            aria-pressed={rate === value}
            onClick={() => onRateChange(value)}
          >
            {value === 1 ? '1×' : `${value / 1 >= 1000 ? `${value / 1000}k` : value}×`}
          </button>
        ))}
        <button type="button" className="rate-btn" onClick={() => onSeek(-SEEK_STEP_MS)} title="Back 30 minutes">
          −30m
        </button>
        <button type="button" className="rate-btn" onClick={() => onSeek(SEEK_STEP_MS)} title="Forward 30 minutes">
          +30m
        </button>
        <button type="button" className="rate-btn" onClick={onNow} title="Return to the current time">
          Now
        </button>
      </div>

      <div className="legend" aria-label="Marker legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: `#${color.toString(16).padStart(6, '0')}` }} />
          {props.catalog?.group ?? 'satellites'}
        </span>
        {props.layers.orbits ? (
          <span className="legend-item">
            <span className="legend-swatch" style={{ background: '#56a5ff', borderRadius: 1 }} />
            orbit path (one period)
          </span>
        ) : null}
        {props.layers.groundTracks ? (
          <span className="legend-item">
            <span className="legend-swatch" style={{ background: '#ffd479', borderRadius: 1 }} />
            ground track (one period)
          </span>
        ) : null}
        <span className="legend-item" style={{ opacity: 0.85 }}>
          Positions are SGP4 predictions from published elements
        </span>
      </div>
    </footer>
  );
}

function categoryKey(group: string): string {
  switch (group) {
    case 'stations':
      return 'crewed';
    case 'visual':
      return 'visual';
    case 'starlink':
    case 'oneweb':
      return 'constellation';
    case 'weather':
      return 'earth-observation';
    case 'science':
      return 'science';
    case 'gps-ops':
      return 'navigation';
    case 'fengyun-1c-debris':
    case 'cosmos-2251-debris':
    case 'iridium-33-debris':
      return 'debris';
    default:
      return 'catalog';
  }
}
