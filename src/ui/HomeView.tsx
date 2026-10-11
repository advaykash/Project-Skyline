/**
 * Home: the Skyline hero and the 30-second invitation to explore.
 */
import { memo } from 'react';
import type { Route } from '../state/store';

export interface HomeViewProps {
  onExplore(): void;
  onTrackIss(): void;
  onNavigate(route: Route): void;
}

export const HomeView = memo(function HomeView(props: HomeViewProps) {
  return (
    <div className="home">
      <section className="hero" aria-label="Introduction">
        <div className="hero-media" aria-hidden="true" />
        <div className="hero-content">
          <p className="eyebrow">Skyline · Everything moving above our world</p>
          <h1>
            Every dot <em>tells a story.</em>
          </h1>
          <p className="lede">
            Explore real satellites, orbital motion, space debris, and the conditions that shape
            what we can observe above Earth — computed live from public orbital data.
          </p>
          <div className="hero-actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={props.onExplore}>
              Explore the globe
            </button>
            <button type="button" className="btn btn-secondary btn-lg" onClick={props.onTrackIss}>
              Track the ISS
            </button>
          </div>
          <p className="hero-note">
            Real CelesTrak elements · SGP4 propagation · honest live / cached / snapshot labels
          </p>
        </div>
      </section>

      <section className="home-grid" aria-label="What you can do">
        <button type="button" className="home-card" onClick={() => props.onNavigate('sky')}>
          <h2>Replay a pass over your town</h2>
          <p>
            Predict when the ISS crosses your sky, then scrub through the pass as the globe, the
            sky chart and every readout move together.
          </p>
          <span className="home-link">Open Orbit-to-Observer Replay →</span>
        </button>
        <button type="button" className="home-card" onClick={() => props.onNavigate('events')}>
          <h2>Understand the debris clouds</h2>
          <p>
            Three documented break-ups left thousands of tracked fragments in orbit. See where the
            survivors fly today — and why crossing lines are not collisions.
          </p>
          <span className="home-link">Explore debris events →</span>
        </button>
        <button type="button" className="home-card" onClick={() => props.onNavigate('weather')}>
          <h2>Check space weather</h2>
          <p>
            The planetary Kp index, measured by NOAA and explained in plain language — context for
            aurora chasers, with no hype.
          </p>
          <span className="home-link">See Kp now →</span>
        </button>
      </section>

      <section className="home-strip" aria-label="How Skyline stays honest">
        <div>
          <strong>Real data, labelled honestly.</strong> Every position traces to a published
          element set and an SGP4 calculation. Cached and snapshot data show their true age —{' '}
          <button type="button" className="link-btn" onClick={() => props.onNavigate('about')}>
            how it works
          </button>
          .
        </div>
      </section>
    </div>
  );
});
