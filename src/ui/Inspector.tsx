import { memo, useMemo } from 'react';
import type { CatalogState, LayerVisibility } from '../state/store';
import type { SatelliteState } from '../orbital/types';
import {
  deriveElements,
  elementAgeDays,
  estimatedAlongTrackDriftKm,
} from '../orbital/derived';
import { describePropagationFailure, toCatalogObject } from '../orbital/elements';
import { StateChip } from './StateChip';
import {
  formatAge,
  formatDuration,
  formatLatitude,
  formatLongitude,
  formatNumber,
  formatUtc,
} from './format';

export interface InspectorProps {
  catalog: CatalogState | null;
  noradId: number | null;
  /** Live state for the selected object, computed at the engine's current time. */
  liveState: SatelliteState | null;
  simTimeMs: number;
  layers: LayerVisibility;
  followSelection: boolean;
  onFocus(): void;
  onFollowToggle(): void;
  onLayerToggle(layer: keyof LayerVisibility): void;
  onSelect(noradId: number | null): void;
}

export const Inspector = memo(function Inspector(props: InspectorProps) {
  const { catalog, noradId, liveState, simTimeMs, layers } = props;

  const record = useMemo(() => {
    if (!catalog || noradId === null) return null;
    return catalog.records.find((r) => Number(r.NORAD_CAT_ID) === noradId) ?? null;
  }, [catalog, noradId]);

  if (!record || noradId === null) {
    return <InspectorEmpty catalog={catalog} />;
  }

  const object = toCatalogObject(record, 0, simTimeMs);
  const derived = deriveElements(object);
  const ageDays = elementAgeDays(object, simTimeMs);
  const drift = estimatedAlongTrackDriftKm(object.elements.meanMotionRevPerDay, ageDays);
  const provenance = catalog?.provenance ?? null;

  return (
    <div className="panel-scroll" style={{ height: '100%' }}>
      <section className="panel-section">
        <div className="inspector-identity">
          <h2 className="inspector-name">{object.name}</h2>
          <div className="inspector-sub">
            NORAD {object.noradId}
            {object.objectId ? ` · ${object.objectId}` : ''}
          </div>
          <div className="badge-row">
            <span className="badge">{catalog?.group}</span>
            <span className="badge">class {object.elements.classification}</span>
            <span className="badge">{derived.regime}</span>
            {derived.isGeosynchronous ? <span className="badge">geosynchronous</span> : null}
          </div>
        </div>

        <div className="action-row" style={{ marginTop: 'var(--space-4)' }}>
          <button type="button" className="btn btn-primary" onClick={props.onFocus}>
            Focus camera
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={props.followSelection}
            onClick={props.onFollowToggle}
          >
            Follow
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={layers.orbits}
            onClick={() => props.onLayerToggle('orbits')}
          >
            Orbit
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={layers.groundTracks}
            onClick={() => props.onLayerToggle('groundTracks')}
          >
            Ground track
          </button>
        </div>
      </section>

      {liveState?.error ? (
        <section className="panel-section">
          <div className="banner banner-warning" role="status">
            <div className="banner-content">
              <div className="banner-title">No usable position at this time</div>
              <div>{describePropagationFailure(liveState.error)}</div>
              <div className="field-note">
                No position is shown instead — OrbitWatch never substitutes invented coordinates for a failed
                propagation.
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {liveState && !liveState.error ? (
        <section className="panel-section">
          <h3 className="section-label">
            Calculated position
            <span style={{ float: 'right', letterSpacing: 0, textTransform: 'none', fontWeight: 400 }}>
              SGP4 @ {formatUtc(simTimeMs)} UTC
            </span>
          </h3>
          <table className="data-table">
            <tbody>
              <tr>
                <th scope="row">Latitude</th>
                <td>{formatLatitude(liveState.geodetic.latitudeDeg)}</td>
              </tr>
              <tr>
                <th scope="row">Longitude</th>
                <td>{formatLongitude(liveState.geodetic.longitudeDeg)}</td>
              </tr>
              <tr>
                <th scope="row">Altitude</th>
                <td>
                  {formatNumber(liveState.geodetic.altitudeKm, 1)}
                  <span className="unit">km above WGS-84</span>
                </td>
              </tr>
              <tr>
                <th scope="row">Speed</th>
                <td>
                  {formatNumber(liveState.speedKmS, 3)}
                  <span className="unit">km/s inertial</span>
                </td>
              </tr>
              <tr>
                <th scope="row">Geocentric radius</th>
                <td>
                  {formatNumber(liveState.radiusKm, 1)}
                  <span className="unit">km</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="field-note">
            Positions are SGP4 predictions from the element set below — not radar tracking. Accuracy depends on element
            age and space weather; see the element-age note.
          </p>
        </section>
      ) : null}

      <section className="panel-section">
        <h3 className="section-label">Source elements · CelesTrak GP</h3>
        <table className="data-table">
          <tbody>
            <tr>
              <th scope="row">Element epoch</th>
              <td>{formatUtc(object.epochMs)}</td>
            </tr>
            <tr>
              <th scope="row">Element age</th>
              <td>
                {ageDays < 0 ? 'future-dated ' : ''}
                {formatNumber(Math.abs(ageDays), 2)}
                <span className="unit">days</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Inclination</th>
              <td>
                {formatNumber(object.elements.inclinationDeg, 4)}
                <span className="unit">deg</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Eccentricity</th>
              <td>{formatNumber(object.elements.eccentricity, 7)}</td>
            </tr>
            <tr>
              <th scope="row">RAAN</th>
              <td>
                {formatNumber(object.elements.raanDeg, 4)}
                <span className="unit">deg</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Arg. of perigee</th>
              <td>
                {formatNumber(object.elements.argPerigeeDeg, 4)}
                <span className="unit">deg</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Mean anomaly</th>
              <td>
                {formatNumber(object.elements.meanAnomalyDeg, 4)}
                <span className="unit">deg</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Mean motion</th>
              <td>
                {formatNumber(object.elements.meanMotionRevPerDay, 7)}
                <span className="unit">rev/day</span>
              </td>
            </tr>
            <tr>
              <th scope="row">B*</th>
              <td>{object.elements.bstar.toExponential(3)}</td>
            </tr>
            <tr>
              <th scope="row">Element set</th>
              <td>
                № {object.elements.elementSetNo}
                <span className="unit">rev {object.elements.revolutionAtEpoch}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="panel-section">
        <h3 className="section-label">Derived properties</h3>
        <table className="data-table">
          <tbody>
            <tr>
              <th scope="row">Orbital period</th>
              <td>{formatDuration(derived.periodMinutes)}</td>
            </tr>
            <tr>
              <th scope="row">Semi-major axis</th>
              <td>
                {formatNumber(derived.semiMajorAxisKm, 0)}
                <span className="unit">km</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Apogee (mean)</th>
              <td>
                {formatNumber(derived.apogeeKm, 0)}
                <span className="unit">km</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Perigee (mean)</th>
              <td>
                {formatNumber(derived.perigeeKm, 0)}
                <span className="unit">km</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="field-note">
          Derived from the published mean elements (Kepler, μ = 398600.8 km³/s², WGS-72). Apogee and perigee are mean
          values; instantaneous SGP4 radius can differ by tens of kilometres due to short-period perturbations.
          {drift && drift.highKm > 0 ? (
            <>
              {' '}
              With elements {Math.abs(ageDays).toFixed(1)} days old, expect roughly {drift.lowKm.toFixed(0)}–
              {drift.highKm.toFixed(0)} km of along-track drift — a planning estimate, not a measurement.
            </>
          ) : null}
        </p>
      </section>

      {provenance ? (
        <section className="panel-section">
          <h3 className="section-label">Data provenance</h3>
          <table className="data-table">
            <tbody>
              <tr>
                <th scope="row">State</th>
                <td>
                  <StateChip state={provenance.state} size="sm" />
                </td>
              </tr>
              <tr>
                <th scope="row">Source</th>
                <td>{provenance.source === 'celestrak' ? 'CelesTrak (live retrieval)' : 'Bundled CelesTrak snapshot'}</td>
              </tr>
              <tr>
                <th scope="row">Retrieved</th>
                <td>
                  {provenance.retrievedAt ? `${formatUtc(Date.parse(provenance.retrievedAt))} UTC` : '—'}
                  <span className="unit">{formatAge(provenance.ageSeconds)}</span>
                </td>
              </tr>
              <tr>
                <th scope="row">Catalogue</th>
                <td>
                  {provenance.recordCount.toLocaleString('en-US')}
                  <span className="unit">records</span>
                </td>
              </tr>
              {provenance.payloadSha256 ? (
                <tr>
                  <th scope="row">Payload SHA-256</th>
                  <td title={provenance.payloadSha256}>{provenance.payloadSha256.slice(0, 12)}…</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="field-note">{provenance.note}</p>
        </section>
      ) : null}
    </div>
  );
});

function InspectorEmpty({ catalog }: { catalog: CatalogState | null }) {
  return (
    <div className="panel-section">
      <h2 className="section-label">Selected object</h2>
      <div className="empty-state" style={{ textAlign: 'left', padding: 'var(--space-2) 0' }}>
        <strong>Nothing selected yet.</strong>
        <p style={{ margin: '0 0 var(--space-3)' }}>
          Search the catalogue on the left and pick an object — or click any marker on the globe. Double-clicking
          the globe focuses the camera on the selection.
        </p>
        <p style={{ margin: 0 }}>
          {catalog
            ? `The ${catalog.records.length.toLocaleString('en-US')} objects in “${catalog.group}” are genuine CelesTrak GP records; every position shown is SGP4-propagated from those elements.`
            : 'Waiting for the first catalogue…'}
        </p>
      </div>
    </div>
  );
}
