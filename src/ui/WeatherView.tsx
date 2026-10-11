/**
 * Space Weather view: NOAA planetary Kp measurements with honest
 * stale/unavailable states and a plain-language explanation.
 */
import { memo, useEffect, useState } from 'react';
import { fetchKpSeries, kpBand, type KpSeries } from '../data/spaceweather';
import { ApiRequestError } from '../data/api';
import { KpChart } from './KpChart';
import { formatAge, formatUtc } from './format';
import { useNow } from './useNow';

const REFRESH_MS = 15 * 60_000;

export const WeatherView = memo(function WeatherView() {
  const [series, setSeries] = useState<KpSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const now = useNow();

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchKpSeries(controller.signal);
        if (!cancelled) setSeries(result);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof ApiRequestError ? err.message : 'NOAA Kp data is unavailable.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, []);

  const latest = series && series.samples.length > 0 ? series.samples[series.samples.length - 1] : null;
  const latestAge = latest ? (now - Date.parse(latest.time)) / 1000 : null;
  const stale = latestAge !== null && latestAge > 9 * 3600;
  const band = latest ? kpBand(latest.kp) : null;

  return (
    <div className="page weather-page">
      <header className="page-header">
        <p className="eyebrow">Space weather</p>
        <h1>Planetary Kp index</h1>
        <p className="lede">
          A 3-hourly measurement of global geomagnetic disturbance from NOAA&apos;s Space Weather
          Prediction Center — useful context for aurora chasers, not a local sky forecast.
        </p>
      </header>

      <div className="weather-layout">
        <section className="card" aria-label="Latest Kp measurement">
          <h2>Latest measurement</h2>
          {loading && !series ? (
            <p className="muted">Loading NOAA data…</p>
          ) : error && !series ? (
            <div className="empty-state">
              <p>{error}</p>
              <p className="muted">
                The explorer, pass predictions and everything else keep working — only this panel
                needs NOAA.
              </p>
            </div>
          ) : latest && band ? (
            <>
              <div className="kp-now">
                <span className="kp-value">{latest.kp.toFixed(2)}</span>
                <span className="kp-band">{band.label}</span>
              </div>
              <p className="muted">{band.detail}</p>
              <dl className="readout-grid">
                <div>
                  <dt>Interval start</dt>
                  <dd>{formatUtc(Date.parse(latest.time))} UTC</dd>
                </div>
                <div>
                  <dt>Age</dt>
                  <dd>
                    {formatAge(latestAge)}
                    {stale ? ' — delayed feed, treated as stale' : ''}
                  </dd>
                </div>
                <div>
                  <dt>Retrieved</dt>
                  <dd>
                    {series ? formatUtc(Date.parse(series.retrievedAt)) : '—'} UTC
                    <span className="sub">{series?.servedFromCache ? ' · edge cache' : ' · fresh fetch'}</span>
                  </dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    <a href="https://www.swpc.noaa.gov/" target="_blank" rel="noreferrer">
                      NOAA SWPC
                    </a>
                  </dd>
                </div>
              </dl>
            </>
          ) : null}
        </section>

        <section className="card" aria-label="Kp history">
          <h2>Recent history</h2>
          {series && series.samples.length > 0 ? (
            <KpChart samples={series.samples.slice(-56)} />
          ) : (
            <p className="muted">No measurements to chart yet.</p>
          )}
        </section>

        <section className="card" aria-label="About the Kp index">
          <h2>What Kp means</h2>
          <p>
            The planetary Kp index compresses magnetometer readings from observatories around the
            world into a single number from 0 (quiet) to 9 (extreme storm) every three hours. NOAA
            issues a storm watch at Kp 5 (G1) and scales up to G5 at Kp 9.
          </p>
          <p>
            Kp describes <em>planetary</em> disturbance. Whether aurora is visible from your town
            also depends on your latitude, local darkness, clouds, moonlight and the view toward
            the pole — a high Kp over a cloudy city at noon still shows nothing.
          </p>
          <p className="muted small">
            Data: NOAA Space Weather Prediction Center. Skyline is an independent project, not
            affiliated with NOAA.
          </p>
        </section>
      </div>
    </div>
  );
});
