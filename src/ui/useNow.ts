import { useEffect, useState } from 'react';

/**
 * A clock value for render-time age formatting.
 *
 * React components must render pure — so relative ages ("2.4 h ago") are
 * computed from this subscribed value rather than by calling `Date.now()`
 * during render.
 */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
