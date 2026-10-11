import type { CatalogState, LayerVisibility } from '../state/store';
import { CATEGORY_COLORS } from '../globe/satellitePoints';
import { formatUtc } from './format';

export interface TimeBarProps {
  simTimeMs: number;
  rate: number;
  catalog: CatalogState | null;
  layers: LayerVisibility;
  onRateChange(rate: number): void;
  onNow(): void;
  onSeek(deltaMs: number): void;
}

const RATES = [1, 60, 300, 1800, 7200];

export function TimeBar(props: TimeBarProps) {
  const category = props.catalog ? categoryKey(props.catalog.group) : 'catalog';
  const color = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.catalog;

  return (
    <footer className="timebar">
      <div className="time-readout">
        <span className="time-value">{formatUtc(props.simTimeMs)} UTC</span>
        <span className="time-caption">
          {props.rate === 1 ? 'simulation time · real time' : `simulation time · ${props.rate.toLocaleString('en-US')}× speed`}
        </span>
      </div>

      <div className="rate-group" role="group" aria-label="Simulation speed">
        {RATES.map((rate) => (
          <button
            key={rate}
            type="button"
            className="rate-btn"
            aria-pressed={props.rate === rate}
            onClick={() => props.onRateChange(rate)}
          >
            {rate === 1 ? '1×' : `${rate / 1 >= 1000 ? `${rate / 1000}k` : rate}×`}
          </button>
        ))}
        <button type="button" className="rate-btn" onClick={() => props.onSeek(-30 * 60_000)} title="Back 30 minutes">
          −30m
        </button>
        <button type="button" className="rate-btn" onClick={() => props.onSeek(30 * 60_000)} title="Forward 30 minutes">
          +30m
        </button>
        <button type="button" className="rate-btn" onClick={props.onNow} title="Return to the current time">
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
