import { stateLabel } from './format';

const DESCRIPTIONS: Record<string, string> = {
  live: 'Retrieved from CelesTrak within the last 2 hours.',
  cached: 'Genuine CelesTrak data retrieved within the last 24 hours; a refresh was attempted and failed.',
  stale: 'Genuine CelesTrak data older than 24 hours. Positions are still computed from real elements, but the prediction quality degrades with element age.',
  snapshot: 'Bundled offline snapshot of genuine CelesTrak records. Not live — the capture time is shown in the data panel.',
  unavailable: 'No data available for this group right now.',
  degraded: 'A live refresh was attempted and failed; the interface is serving the last genuine data and says so.',
};

export function StateChip({
  state,
  size = 'md',
  title,
}: {
  state: string;
  size?: 'md' | 'sm';
  title?: string;
}) {
  return (
    <span
      className={`state-chip state-${state}`}
      title={title ?? DESCRIPTIONS[state] ?? ''}
      data-state={state}
      style={size === 'sm' ? { height: 20, fontSize: '0.625rem', padding: '0 8px' } : undefined}
    >
      <span className="state-dot" aria-hidden="true" />
      {stateLabel(state)}
    </span>
  );
}
