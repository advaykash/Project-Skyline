/**
 * Orbit-to-Observer Replay: the signature Skyline workflow.
 *
 * One shared object selection, one shared observer and one shared simulation
 * clock drive every element here: the pass list, the replay timeline, the
 * local-sky chart, the observer-relative readouts and the observing context.
 * Moving the replay time moves the globe marker too — both are SGP4
 * evaluations at the same instant, so they cannot disagree.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogState } from '../state/store';
import { getState, setState, useStore } from '../state/store';
import { storeObserver } from '../state/observer';
import { buildSatrec } from '../orbital/elements';
import {
  compassPoint,
  darknessCategory,
  darknessLabel,
  illuminationLabel,
  lookAnglesAt,
  satelliteIllumination,
  solarAltitudeDeg,
  sunDirectionEcef,
  viewingScore,
  type ObserverLocation,
  type PredictedPass,
} from '../orbital/observer';
import { propagateState } from '../orbital/elements';
import {
  getRate,
  getTimeMs,
  resetToNow,
  setRate,
  setTime,
  subscribe as subscribeClock,
  getTimeMs as clockNow,
} from '../state/clock';
import { fetchWeatherForecast, cloudCoverAt, type WeatherForecast } from '../data/weather';
import { SkyChart } from './SkyChart';
import { ObserverPicker } from './ObserverPicker';
import { usePasses } from './usePasses';
import { formatNumber, formatUtc } from './format';

const WINDOW_HOURS = 48;

export interface SkyViewProps {
  catalog: CatalogState | null;
  catalogLoading: boolean;
  onOpenExplorer(): void;
  onTrackIss(): void;
}

function formatLocal(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      day: 'numeric',
      month: 'short',
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export const SkyView = memo(function SkyView(props: SkyViewProps) {
  const { catalog, catalogLoading, onOpenExplorer, onTrackIss } = props;
  const selectedNoradId = useStore((s) => s.selectedNoradId);
  const observer = useStore((s) => s.observer);
  const replayPass = useStore((s) => s.replayPass);

  const [simTimeMs, setSimTimeMs] = useState(() => getTimeMs());
  const [rate, setRateState] = useState(() => getRate());
  const [windowAnchor, setWindowAnchor] = useState(() => Date.now());
  const [forecast, setForecast] = useState<WeatherForecast | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);

  useEffect(() => subscribeClock((ms) => setSimTimeMs(ms)), []);
  useEffect(() => {
    setRateState(getRate());
  }, [simTimeMs]);

  const record = useMemo(() => {
    if (!catalog || selectedNoradId === null) return null;
    return catalog.records.find((r) => Number(r.NORAD_CAT_ID) === selectedNoradId) ?? null;
  }, [catalog, selectedNoradId]);

  const satrec = useMemo(() => {
    if (!record) return null;
    try {
      return buildSatrec(record);
    } catch {
      return null;
    }
  }, [record]);

  const { passes, window } = usePasses(satrec, selectedNoradId, observer, WINDOW_HOURS, windowAnchor);

  // Drop a replay pass that no longer matches the object or observer.
  useEffect(() => {
    const current = getState().replayPass;
    if (!current || current.noradId !== selectedNoradId) {
      if (current) setState({ replayPass: null });
      return;
    }
  }, [selectedNoradId, observer, passes]);

  // Cloud context follows the observer (advisory only; failures are shown).
  useEffect(() => {
    let cancelled = false;
    setForecast(null);
    setForecastError(null);
    const controller = new AbortController();
    fetchWeatherForecast(observer.latitudeDeg, observer.longitudeDeg, controller.signal)
      .then((result) => {
        if (!cancelled) setForecast(result);
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setForecastError(error instanceof Error ? error.message : 'Forecast unavailable.');
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [observer.latitudeDeg, observer.longitudeDeg]);

  const onObserverChange = (next: ObserverLocation) => {
    storeObserver(next);
    setState({ observer: next, replayPass: null });
  };

  const selectPass = (pass: PredictedPass) => {
    setState({ replayPass: pass });
    setTime(pass.rise.timeMs - 30_000);
    setSimTimeMs(pass.rise.timeMs - 30_000);
    // A pass lasts minutes: drop absurd explorer speeds to a watchable replay
    // rate, but respect an explicit pause.
    if (getRate() !== 0) {
      setRate(30);
      setRateState(30);
    }
  };

  const clearPass = () => setState({ replayPass: null });

  const onScrub = (timeMs: number) => {
    setTime(timeMs);
    setSimTimeMs(timeMs);
  };

  const lastRateRef = useRef(30);
  const onPlayPause = () => {
    if (rate === 0) {
      const restore = lastRateRef.current === 0 ? 30 : lastRateRef.current;
      setRate(restore);
      setRateState(restore);
    } else {
      lastRateRef.current = rate;
      setRate(0);
      setRateState(0);
    }
  };

  const onBackToLive = () => {
    resetToNow();
    setSimTimeMs(clockNow());
    setRateState(1);
  };

  // Live geometry at the shared simulation time.
  const live = useMemo(() => {
    if (!satrec || selectedNoradId === null) return null;
    const look = lookAnglesAt(satrec, selectedNoradId, observer, simTimeMs);
    if (!look) return null;
    const date = new Date(simTimeMs);
    const state = propagateState(satrec, selectedNoradId, date);
    const illumination = state.error
      ? null
      : satelliteIllumination(state.positionEcefKm, sunDirectionEcef(date));
    return {
      look,
      illumination,
      sunAltitudeDeg: solarAltitudeDeg(observer, date),
    };
  }, [satrec, selectedNoradId, observer, simTimeMs]);

  const cloudAtPeak = useMemo(() => {
    if (!forecast || !replayPass) return null;
    return cloudCoverAt(forecast, replayPass.peak.timeMs);
  }, [forecast, replayPass]);

  const score = useMemo(() => {
    if (!replayPass) return null;
    return viewingScore({ pass: replayPass, cloudCoverPercent: cloudAtPeak });
  }, [replayPass, cloudAtPeak]);

  const inReplayWindow =
    replayPass !== null &&
    simTimeMs >= replayPass.rise.timeMs - 120_000 &&
    simTimeMs <= replayPass.set.timeMs + 120_000;

  return (
    <div className="page sky-page">
      <header className="page-header">
        <p className="eyebrow">Orbit-to-Observer Replay</p>
        <h1>From orbit to your sky</h1>
        <p className="lede">
          Pick a satellite and a location. Skyline predicts when it passes overhead, then replays
          the pass through one shared clock — globe position, sky path and observing conditions
          always in step.
        </p>
      </header>

      <div className="sky-layout">
        <div className="sky-column">
          <section className="card" aria-label="Selected object">
            <h2>Object</h2>
            {record ? (
              <div className="object-summary">
                <div className="object-name">{String(record.OBJECT_NAME)}</div>
                <div className="object-meta">
                  NORAD {selectedNoradId} · {String(record.OBJECT_ID ?? '—')}
                </div>
                <div className="row-actions">
                  <button type="button" className="btn btn-secondary" onClick={onOpenExplorer}>
                    View on globe
                  </button>
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <p>
                  {catalogLoading
                    ? 'Loading the catalogue…'
                    : 'No object selected yet. Track the space station or pick any satellite in the explorer.'}
                </p>
                <div className="row-actions">
                  <button type="button" className="btn btn-primary" onClick={onTrackIss}>
                    Track the ISS
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={onOpenExplorer}>
                    Open explorer
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="card" aria-label="Observer">
            <h2>Observer</h2>
            <ObserverPicker observer={observer} onChange={onObserverChange} />
          </section>

          <section className="card" aria-label="Predicted passes">
            <div className="card-header-row">
              <h2>Upcoming passes</h2>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setWindowAnchor(Date.now())}
                title="Recompute predictions from the current time"
              >
                Refresh
              </button>
            </div>
            {!record || !satrec ? (
              <p className="muted">Select an object to predict its passes.</p>
            ) : passes.length === 0 ? (
              <div className="empty-state">
                <p>
                  No passes above 10° elevation for {window ? 'the next 48 hours' : 'this window'}.
                  Low-inclination satellites may never rise for high-latitude observers.
                </p>
                <p className="muted">Try another object, another location, or refresh later.</p>
              </div>
            ) : (
              <>
                <p className="muted small">
                  {window ? (
                    <>
                      {formatUtc(window.startMs, false)} → {formatUtc(window.endMs, false)} UTC · min
                      elevation 10°
                    </>
                  ) : null}
                </p>
                <ol className="pass-list">
                  {passes.map((pass) => {
                    const active = replayPass !== null && replayPass.peak.timeMs === pass.peak.timeMs;
                    return (
                      <li key={pass.peak.timeMs}>
                        <button
                          type="button"
                          className={`pass-item${active ? ' is-active' : ''}`}
                          aria-pressed={active}
                          onClick={() => selectPass(pass)}
                        >
                          <span className="pass-peak">
                            {formatClock(pass.peak.timeMs)} UTC
                            <span className="pass-local"> · {formatLocal(pass.peak.timeMs)} your time</span>
                          </span>
                          <span className="pass-meta">
                            peak {pass.maxElevationDeg.toFixed(0)}° {compassPoint(pass.peak.azimuthDeg)} ·{' '}
                            {compassPoint(pass.rise.azimuthDeg)}→{compassPoint(pass.set.azimuthDeg)} ·{' '}
                            {Math.round(pass.durationMs / 60_000)} min
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </section>
        </div>

        <div className="sky-column">
          <section className="card replay-card" aria-label="Pass replay">
            <div className="card-header-row">
              <h2>Replay</h2>
              {replayPass ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearPass}>
                  Clear pass
                </button>
              ) : null}
            </div>
            {!replayPass || !satrec || selectedNoradId === null ? (
              <div className="empty-state">
                <p>Select a pass to replay it: scrub the timeline and watch the sky path, the globe
                position and every readout move together.</p>
              </div>
            ) : (
              <>
                <div className="replay-time">
                  <span className="replay-clock">{formatUtc(simTimeMs)} UTC</span>
                  <span className="replay-rate">
                    {rate === 0 ? 'paused' : rate === 1 ? 'real time' : `${rate}× speed`}
                  </span>
                </div>
                <input
                  type="range"
                  className="replay-scrub"
                  min={replayPass.rise.timeMs - 60_000}
                  max={replayPass.set.timeMs + 60_000}
                  step={1000}
                  value={Math.min(
                    Math.max(simTimeMs, replayPass.rise.timeMs - 60_000),
                    replayPass.set.timeMs + 60_000,
                  )}
                  onChange={(event) => onScrub(Number(event.target.value))}
                  aria-label="Scrub through the predicted pass"
                />
                <div className="replay-marks" aria-hidden="true">
                  <span>Rise {formatClock(replayPass.rise.timeMs)}</span>
                  <span>Peak {formatClock(replayPass.peak.timeMs)}</span>
                  <span>Set {formatClock(replayPass.set.timeMs)}</span>
                </div>
                <div className="row-actions replay-controls">
                  <button type="button" className="btn btn-primary" onClick={onPlayPause}>
                    {rate === 0 ? 'Play' : 'Pause'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onScrub(replayPass.rise.timeMs - 30_000)}
                  >
                    Rise
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onScrub(replayPass.peak.timeMs)}
                  >
                    Peak
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onScrub(replayPass.set.timeMs)}
                  >
                    Set
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={onBackToLive}>
                    Back to live
                  </button>
                </div>
                {!inReplayWindow ? (
                  <p className="notice">
                    Replay time is outside this pass — the sky marker is hidden and the globe shows
                    the object&apos;s position at the current simulation time instead. Scrub back
                    into the pass to follow it.
                  </p>
                ) : null}

                <div className="sky-chart-row">
                  <SkyChart
                    satrec={satrec}
                    noradId={selectedNoradId}
                    observer={observer}
                    pass={replayPass}
                    simTimeMs={simTimeMs}
                    sunAltitudeDeg={live ? live.sunAltitudeDeg : -18}
                  />
                </div>

                <dl className="readout-grid">
                  <div>
                    <dt>Azimuth</dt>
                    <dd>
                      {live?.look ? `${live.look.azimuthDeg.toFixed(1)}° ${compassPoint(live.look.azimuthDeg)}` : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Elevation</dt>
                    <dd>{live?.look ? `${live.look.elevationDeg.toFixed(1)}°` : '—'}</dd>
                  </div>
                  <div>
                    <dt>Range</dt>
                    <dd>{live?.look ? `${formatNumber(live.look.rangeKm, 0)} km` : '—'}</dd>
                  </div>
                  <div>
                    <dt>Altitude</dt>
                    <dd>{live?.look ? `${formatNumber(live.look.altitudeKm, 1)} km` : '—'}</dd>
                  </div>
                  <div>
                    <dt>Illumination</dt>
                    <dd>{live?.illumination ? illuminationLabel(live.illumination) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Darkness</dt>
                    <dd>
                      {live
                        ? `${darknessLabel(darknessCategory(live.sunAltitudeDeg))} (Sun ${live.sunAltitudeDeg.toFixed(1)}°)`
                        : '—'}
                    </dd>
                  </div>
                </dl>
              </>
            )}
          </section>

          <section className="card" aria-label="Observing context">
            <h2>Observing context</h2>
            {!replayPass ? (
              <p className="muted">Context appears here once a pass is selected.</p>
            ) : (
              <>
                <dl className="readout-grid">
                  <div>
                    <dt>Peak</dt>
                    <dd>
                      {formatUtc(replayPass.peak.timeMs)} UTC
                      <span className="sub"> {formatLocal(replayPass.peak.timeMs)} your time</span>
                    </dd>
                  </div>
                  <div>
                    <dt>Max elevation</dt>
                    <dd>
                      {replayPass.maxElevationDeg.toFixed(1)}° {compassPoint(replayPass.peak.azimuthDeg)}
                    </dd>
                  </div>
                  <div>
                    <dt>Path</dt>
                    <dd>
                      {compassPoint(replayPass.rise.azimuthDeg)} → {compassPoint(replayPass.set.azimuthDeg)} ·{' '}
                      {Math.round(replayPass.durationMs / 60_000)} min
                    </dd>
                  </div>
                  <div>
                    <dt>Cloud cover at peak</dt>
                    <dd>
                      {forecastError
                        ? 'Unavailable'
                        : forecast === null
                          ? 'Loading…'
                          : cloudAtPeak === null
                            ? 'No forecast for this hour'
                            : `${cloudAtPeak.toFixed(0)}%`}
                      <span className="sub">
                        {forecast ? ` · Open-Meteo, retrieved ${formatUtc(Date.parse(forecast.retrievedAt))} UTC` : forecastError ? ` · ${forecastError}` : ''}
                      </span>
                    </dd>
                  </div>
                </dl>

                {score ? (
                  <div className="score-block">
                    <div className="score-header">
                      <span className="score-value">{score.score}</span>
                      <span className="score-grade">{score.grade}</span>
                      <span className="score-title">observing opportunity heuristic</span>
                    </div>
                    <ul className="score-factors">
                      {score.factors.map((factor) => (
                        <li key={factor.name}>
                          <span className="factor-name">{factor.name}</span>
                          <span className="factor-detail">{factor.detail}</span>
                          <span className="factor-points">
                            {factor.points}/{factor.maxPoints}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {score.assumptions.map((assumption) => (
                      <p key={assumption} className="notice">
                        {assumption}
                      </p>
                    ))}
                    <p className="muted small">
                      A heuristic for comparing opportunities — not a probability of seeing the
                      satellite. Brightness, haze and obstructions also matter.
                    </p>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
});
