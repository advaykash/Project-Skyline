/**
 * Validation of untrusted upstream payloads.
 *
 * CelesTrak is the *only* upstream, but its responses are still treated as
 * untrusted: a truncated download, an HTML error page or a schema change must
 * fail loudly and be rejected, never passed through to the interface as if it
 * were a valid catalogue.
 */

export interface MinimalRecordCheck {
  OBJECT_NAME: string;
  NORAD_CAT_ID: number;
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
}

export type PayloadCheck =
  | { ok: true; records: MinimalRecordCheck[]; epochRange: { min: string; max: string } }
  | { ok: false; reason: string };

const REQUIRED = ['OBJECT_NAME', 'NORAD_CAT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION'] as const;

/**
 * Structurally validate a GP payload. Returns the parsed records and the range
 * of element epochs when valid; otherwise a reason string explaining what is
 * wrong with the payload.
 */
export function validateGpPayload(text: string): PayloadCheck {
  if (text.trimStart().startsWith('<')) {
    return { ok: false, reason: 'upstream returned HTML instead of JSON' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'upstream response is not valid JSON' };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'upstream payload is not a JSON array' };
  if (parsed.length === 0) return { ok: false, reason: 'upstream payload contains no records' };

  const epochs: string[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const rec = parsed[i] as Record<string, unknown>;
    if (typeof rec !== 'object' || rec === null) {
      return { ok: false, reason: `record #${i} is not an object` };
    }
    for (const field of REQUIRED) {
      const value = rec[field];
      if (value === undefined || value === null || value === '') {
        return { ok: false, reason: `record #${i} is missing ${field}` };
      }
    }
    if (typeof rec.OBJECT_NAME !== 'string' || rec.OBJECT_NAME.trim() === '') {
      return { ok: false, reason: `record #${i} has an empty OBJECT_NAME` };
    }
    const epoch = String(rec.EPOCH);
    if (Number.isNaN(Date.parse(epoch))) {
      return { ok: false, reason: `record #${i} has an unparseable EPOCH` };
    }
    const meanMotion = Number(rec.MEAN_MOTION);
    const eccentricity = Number(rec.ECCENTRICITY);
    if (!Number.isFinite(meanMotion) || meanMotion <= 0) {
      return { ok: false, reason: `record #${i} has a non-physical MEAN_MOTION` };
    }
    if (!Number.isFinite(eccentricity) || eccentricity < 0 || eccentricity >= 1) {
      return { ok: false, reason: `record #${i} has an out-of-range ECCENTRICITY` };
    }
    epochs.push(epoch);
  }

  epochs.sort();
  return {
    ok: true,
    records: parsed as MinimalRecordCheck[],
    epochRange: { min: epochs[0], max: epochs[epochs.length - 1] },
  };
}
