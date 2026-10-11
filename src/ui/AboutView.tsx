/**
 * "How It Works": the data pipeline, the real-vs-estimated ledger, the
 * educational-use disclaimer and full attribution.
 */
import { memo } from 'react';

export const AboutView = memo(function AboutView() {
  return (
    <div className="page about-page">
      <header className="page-header">
        <p className="eyebrow">How it works</p>
        <h1>From elements to dots</h1>
        <p className="lede">
          Skyline turns public orbital-element records into positions on a globe — through a
          documented pipeline with no invented steps. Here is exactly what happens, and what each
          number is allowed to claim.
        </p>
      </header>

      <section className="card" aria-label="The pipeline">
        <h2>The pipeline in three stages</h2>
        <ol className="pipeline">
          <li>
            <strong>1 · Retrieve.</strong> Public General Perturbations (GP) element sets are
            fetched from CelesTrak&apos;s documented JSON endpoints through a same-origin API that
            validates every record, caches honestly, and falls back to a dated bundled snapshot —
            always labelled for what it is.
          </li>
          <li>
            <strong>2 · Propagate.</strong> SGP4 (via satellite.js) advances each element set to the
            simulation time. SGP4 <em>calculates</em> positions from elements; it does not observe
            satellites, and its accuracy declines as elements age.
          </li>
          <li>
            <strong>3 · Transform &amp; plot.</strong> The inertial result is rotated once by GMST
            into Earth-fixed coordinates, converted to geodetic latitude/longitude on WGS-84, and
            drawn — one draw call for the whole catalogue, plus trails and ground tracks from the
            same math.
          </li>
        </ol>
      </section>

      <section className="card" aria-label="What is real and what is estimated">
        <h2>What is real, and what is estimated?</h2>
        <div className="ledger">
          <div>
            <h3>Real records</h3>
            <ul>
              <li>Orbital element sets published by CelesTrak (verbatim, checksummed).</li>
              <li>NOAA planetary Kp measurements with retrieval timestamps.</li>
              <li>Earth imagery from NASA Visible Earth (see credits).</li>
            </ul>
          </div>
          <div>
            <h3>Calculated from real records</h3>
            <ul>
              <li>Satellite positions, velocities and orbit trails (SGP4 + frame transforms).</li>
              <li>Azimuth, elevation, range and pass predictions (pure geometry).</li>
              <li>Sunlit / eclipsed states, solar altitude and darkness (ephemeris geometry).</li>
            </ul>
          </div>
          <div>
            <h3>Forecasts &amp; heuristics</h3>
            <ul>
              <li>Cloud-cover forecasts from Open-Meteo — model output, not observation.</li>
              <li>The observing-opportunity score — a disclosed heuristic, not a probability.</li>
              <li>Along-track drift ranges — conservative rules of thumb, labelled as such.</li>
            </ul>
          </div>
          <div>
            <h3>Illustrative, never measurements</h3>
            <ul>
              <li>Static cloud textures and starfields (labelled illustrative).</li>
              <li>Cached or snapshot data shown with its real age — never as live.</li>
              <li>Simulated playback time — always distinguished from wall-clock time.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="card" aria-label="Limitations">
        <h2>Limitations, stated plainly</h2>
        <ul className="honesty-list">
          <li>Positions are predictions, not tracking observations; stale elements drift.</li>
          <li>Debris orbits are especially uncertain; manoeuvres invalidate elements silently.</li>
          <li>Pass predictions are geometric — clouds, brightness and obstructions decide reality.</li>
          <li>Historical debris clouds show surviving fragments today, not the break-up moment.</li>
          <li>
            Skyline is an <strong>educational visualization</strong>, not an operational
            space-safety system. It is not suitable for collision avoidance, conjunction
            assessment, re-entry prediction or spacecraft operations.
          </li>
        </ul>
      </section>

      <section className="card" aria-label="Credits">
        <h2>Credits &amp; attribution</h2>
        <ul className="honesty-list">
          <li>
            Orbital data: <a href="https://celestrak.org/" target="_blank" rel="noreferrer">CelesTrak</a>{' '}
            (public GP data; refresh policy follows their usage guidance).
          </li>
          <li>
            Propagation: SGP4 via{' '}
            <a href="https://github.com/shashwatak/satellite-js" target="_blank" rel="noreferrer">satellite.js</a>;
            rendering via{' '}
            <a href="https://threejs.org/" target="_blank" rel="noreferrer">Three.js</a>.
          </li>
          <li>
            Earth imagery: NASA Visible Earth / Blue Marble; night lights: NASA Earth Observatory.
          </li>
          <li>
            Cloud forecasts:{' '}
            <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>; space
            weather: <a href="https://www.swpc.noaa.gov/" target="_blank" rel="noreferrer">NOAA SWPC</a>.
          </li>
          <li>
            Skyline is an independent project and is not affiliated with NASA, ESA, NOAA, CelesTrak
            or Open-Meteo.
          </li>
        </ul>
      </section>
    </div>
  );
});
