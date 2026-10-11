/**
 * Historical fragmentation events: education, not prediction.
 *
 * Each card states what is known (sourced facts), what Skyline visualizes
 * (current orbital elements of surviving fragments — NOT the historical
 * break-up), and what Skyline cannot do (collision forecasting). Two orbit
 * lines crossing on screen never implies a collision.
 */
import { memo } from 'react';

export interface EventsViewProps {
  onExploreGroup(group: string, label: string): void;
}

interface DebrisEvent {
  id: string;
  title: string;
  date: string;
  tag: string;
  summary: string;
  parents: string[];
  aftermath: string;
  groups: Array<{ id: string; label: string }>;
  sources: Array<{ label: string; url: string }>;
}

const EVENTS: DebrisEvent[] = [
  {
    id: 'fengyun-1c',
    title: 'Fengyun-1C interception',
    date: '11 January 2007',
    tag: 'Anti-satellite test · ~865 km altitude',
    summary:
      'A retired Chinese weather satellite, Fengyun-1C, was struck by a ground-launched interceptor. ' +
      'The hypervelocity impact shattered the ~750 kg spacecraft into thousands of trackable fragments, ' +
      'creating the largest single debris cloud in low Earth orbit.',
    parents: ['Fengyun-1C (NORAD 25730)'],
    aftermath:
      'Because the break-up happened near 865 km — where atmospheric drag is weak — most fragments will ' +
      'remain in orbit for many decades. Skyline serves the surviving catalogued population from CelesTrak; ' +
      'what you see on the globe is where those fragments are today, propagated from current elements.',
    groups: [{ id: 'fengyun-1c-debris', label: 'Fengyun-1C debris cloud' }],
    sources: [
      { label: 'NASA Orbital Debris Program Office', url: 'https://orbitaldebris.jsc.nasa.gov/' },
      { label: 'CelesTrak debris groups', url: 'https://celestrak.org/' },
    ],
  },
  {
    id: 'iridium-cosmos',
    title: 'Iridium 33 – Cosmos 2251 collision',
    date: '10 February 2009',
    tag: 'Accidental collision · ~776 km altitude',
    summary:
      'The active communications satellite Iridium 33 collided with the retired Russian satellite ' +
      'Cosmos 2251 over Siberia at a closing speed of roughly 11.6 km/s. It was the first accidental ' +
      'hypervelocity collision between two intact satellites, and both spacecraft were destroyed.',
    parents: ['Iridium 33 (NORAD 33776)', 'Cosmos 2251 (NORAD 22675)'],
    aftermath:
      'The collision produced two catalogued debris clouds that operators still track and dodge today. ' +
      'Open either cloud to explore where the surviving fragments orbit now — current elements cannot ' +
      'reproduce the 2009 impact geometry, so Skyline does not attempt a “replay” of the collision itself.',
    groups: [
      { id: 'cosmos-2251-debris', label: 'Cosmos-2251 fragments' },
      { id: 'iridium-33-debris', label: 'Iridium-33 fragments' },
    ],
    sources: [
      { label: 'NASA Orbital Debris Program Office', url: 'https://orbitaldebris.jsc.nasa.gov/' },
      { label: 'ESA Space Safety', url: 'https://www.esa.int/Space_Safety' },
      { label: 'CelesTrak debris groups', url: 'https://celestrak.org/' },
    ],
  },
  {
    id: 'cosmos-1408',
    title: 'Cosmos 1408 interception',
    date: '15 November 2021',
    tag: 'Anti-satellite test · ~480 km altitude',
    summary:
      'The retired Soviet-era signals-intelligence satellite Cosmos 1408 was struck by a ground-launched ' +
      'interceptor, generating a debris cloud that at one point prompted precautionary sheltering aboard ' +
      'the International Space Station.',
    parents: ['Cosmos 1408 (NORAD 13552)'],
    aftermath:
      'Skyline does not currently carry a dedicated Cosmos 1408 debris group, so this event is presented ' +
      'as a factual explainer only — no fragments are plotted and none are implied. Lower altitude means ' +
      'drag clears these fragments faster than the 2007 cloud, but the hazard persists for years.',
    groups: [],
    sources: [
      { label: 'NASA Orbital Debris Program Office', url: 'https://orbitaldebris.jsc.nasa.gov/' },
      { label: 'ESA Space Safety', url: 'https://www.esa.int/Space_Safety' },
    ],
  },
];

export const EventsView = memo(function EventsView(props: EventsViewProps) {
  return (
    <div className="page events-page">
      <header className="page-header">
        <p className="eyebrow">Space debris · education</p>
        <h1>When orbits break apart</h1>
        <p className="lede">
          Three documented fragmentation events, and the debris populations they left behind. What
          Skyline can show is honest and limited: the fragments we still track, where they are
          today — never a reconstruction of the impacts themselves.
        </p>
      </header>

      <section className="card honesty-card" aria-label="How to read this page">
        <h2>How to read this page</h2>
        <ul className="honesty-list">
          <li>
            <strong>Documented history.</strong> Dates, parent objects and descriptions come from
            authoritative sources, linked below each event.
          </li>
          <li>
            <strong>Current data, not time travel.</strong> Debris clouds show{' '}
            <em>today&apos;s</em> positions of surviving fragments, computed from current orbital
            elements. They cannot show where fragments were in 2007 or 2009.
          </li>
          <li>
            <strong>Crossing lines are not collisions.</strong> Two orbit paths intersecting on
            screen says nothing about two objects meeting. Real conjunction assessment needs
            uncertainty data and analysis Skyline does not perform.
          </li>
          <li>
            <strong>Not all debris is shown.</strong> Only catalogued, published fragments appear.
            Small, untracked and unpublished objects are absent — the real clouds are denser.
          </li>
        </ul>
      </section>

      <div className="events-grid">
        {EVENTS.map((event) => (
          <article key={event.id} className="card event-card" aria-label={event.title}>
            <p className="event-date">{event.date}</p>
            <h2>{event.title}</h2>
            <p className="event-tag">{event.tag}</p>
            <p>{event.summary}</p>
            <p>
              <strong>Parent objects: </strong>
              {event.parents.join(' · ')}
            </p>
            <p className="muted">{event.aftermath}</p>
            {event.groups.length > 0 ? (
              <div className="row-actions">
                {event.groups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => props.onExploreGroup(group.id, group.label)}
                  >
                    Explore {group.label.toLowerCase()}
                  </button>
                ))}
              </div>
            ) : (
              <p className="notice">No plotted debris group — explainer only.</p>
            )}
            <p className="sources">
              Sources:{' '}
              {event.sources.map((source, i) => (
                <span key={source.url}>
                  {i > 0 ? ' · ' : ''}
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.label}
                  </a>
                </span>
              ))}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
});
