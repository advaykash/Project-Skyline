/**
 * Observer location picker: presets, custom coordinates and explicit
 * browser geolocation. Every change flows into the shared observer state, so
 * pass predictions, the sky chart, darkness and cloud context recompute from
 * the same coordinates.
 */
import { memo, useState } from 'react';
import type { ObserverLocation } from '../orbital/observer';
import {
  OBSERVER_PRESETS,
  formatObserver,
  parseCustomObserver,
} from '../state/observer';

export interface ObserverPickerProps {
  observer: ObserverLocation;
  onChange(observer: ObserverLocation): void;
}

export const ObserverPicker = memo(function ObserverPicker(props: ObserverPickerProps) {
  const { observer, onChange } = props;
  const [latText, setLatText] = useState('');
  const [lonText, setLonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const activePreset = OBSERVER_PRESETS.find(
    (p) =>
      Math.abs(p.latitudeDeg - observer.latitudeDeg) < 1e-9 &&
      Math.abs(p.longitudeDeg - observer.longitudeDeg) < 1e-9,
  );

  const applyCustom = () => {
    const parsed = parseCustomObserver(latText, lonText);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onChange(parsed.observer);
  };

  const useBrowserLocation = () => {
    if (!('geolocation' in navigator)) {
      setError('This browser does not provide geolocation.');
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        onChange({
          latitudeDeg: position.coords.latitude,
          longitudeDeg: position.coords.longitude,
          label: 'My location (browser)',
        });
      },
      (failure) => {
        setLocating(false);
        setError(
          failure.code === failure.PERMISSION_DENIED
            ? 'Location permission was denied — your coordinates stay private and the previous observer is kept.'
            : 'Your location could not be determined; the previous observer is kept.',
        );
      },
      { timeout: 10_000, maximumAge: 600_000 },
    );
  };

  return (
    <section className="observer-picker" aria-label="Observer location">
      <div className="observer-current">
        <div>
          <div className="observer-label">{observer.label ?? 'Custom location'}</div>
          <div className="observer-coords">{formatObserver(observer)}</div>
        </div>
      </div>

      <div className="preset-grid" role="group" aria-label="Observer presets">
        {OBSERVER_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`chip-btn${activePreset?.id === preset.id ? ' is-active' : ''}`}
            aria-pressed={activePreset?.id === preset.id}
            onClick={() =>
              onChange({
                latitudeDeg: preset.latitudeDeg,
                longitudeDeg: preset.longitudeDeg,
                label: preset.label,
              })
            }
          >
            {preset.label}
          </button>
        ))}
      </div>

      <form
        className="custom-coords"
        onSubmit={(event) => {
          event.preventDefault();
          applyCustom();
        }}
      >
        <label className="coord-field">
          <span>Latitude</span>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="40.357"
            value={latText}
            onChange={(event) => setLatText(event.target.value)}
            aria-label="Custom latitude in degrees, minus 90 to 90"
          />
        </label>
        <label className="coord-field">
          <span>Longitude</span>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="−74.667"
            value={lonText}
            onChange={(event) => setLonText(event.target.value)}
            aria-label="Custom longitude in degrees, minus 180 to 180"
          />
        </label>
        <button type="submit" className="btn btn-secondary">
          Set location
        </button>
      </form>

      <button
        type="button"
        className="btn btn-ghost"
        onClick={useBrowserLocation}
        disabled={locating}
      >
        {locating ? 'Locating…' : 'Use my location'}
      </button>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="privacy-note">
        Coordinates are stored only in this browser and are sent solely to the forecast endpoint
        when you open observing context.
      </p>
    </section>
  );
});
