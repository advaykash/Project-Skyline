/**
 * API client for the same-origin OrbitWatch API.
 *
 * Everything the interface displays about data provenance comes from these
 * responses — the client never guesses freshness and never labels anything
 * "live" on its own.
 */
import type { ApiError, GpResponse, HealthResponse } from '../../shared/contracts';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly status: number;

  constructor(message: string, options: { code: string; hint?: string; status: number }) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = options.code;
    this.hint = options.hint;
    this.status = options.status;
  }
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { accept: 'application/json' },
      signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError('The application API could not be reached.', {
      code: 'network',
      hint: 'Check that the API process is running, then retry.',
      status: 0,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError('The application API returned a malformed response.', {
      code: 'malformed',
      status: response.status,
    });
  }

  if (!response.ok) {
    const error = (payload as ApiError).error;
    throw new ApiRequestError(error?.message ?? `Request failed with HTTP ${response.status}.`, {
      code: error?.code ?? 'http-error',
      hint: error?.hint,
      status: response.status,
    });
  }
  return payload as T;
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/api/health', signal);
}

export function fetchCatalog(group: string, signal?: AbortSignal): Promise<GpResponse> {
  return requestJson<GpResponse>(`/api/gp?group=${encodeURIComponent(group)}`, signal);
}
