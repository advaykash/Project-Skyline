/**
 * GET /api/gp?group=<id>
 *
 * Returns genuine CelesTrak GP records for one allowlisted catalogue group,
 * together with explicit provenance metadata (source, retrieval time, age,
 * epoch range, data state).
 *
 * Status codes:
 *   200  records returned (state: live | cached | stale | snapshot)
 *   400  missing or unknown `group`
 *   429  rate limited
 *   502  upstream failed and no genuine data of any kind is available
 */
import { getCatalog } from './_lib/service';
import { buildServiceContext, type RuntimeEnv } from './_lib/context';
import { checkRateLimit, clientKey } from './_lib/ratelimit';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

const json = (body: unknown, status: number, extra?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });

export const onRequestGet: PagesFunction<RuntimeEnv> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const group = url.searchParams.get('group');

  if (!group) {
    return json(
      {
        ok: false,
        error: {
          code: 'bad-request',
          message: 'Missing required query parameter "group".',
          hint: 'Example: /api/gp?group=stations',
        },
      },
      400,
    );
  }

  const rate = checkRateLimit(clientKey(request), Date.now());
  if (!rate.allowed) {
    return json(
      {
        ok: false,
        error: {
          code: 'rate-limited',
          message: 'Too many requests from this client.',
          hint: `Retry in ${rate.retryAfterSeconds} seconds.`,
        },
      },
      429,
      { 'retry-after': String(rate.retryAfterSeconds) },
    );
  }

  const result = await getCatalog(buildServiceContext(env), group);
  if (!result.ok) return json(result.error, result.httpStatus);
  return json(result.response, result.httpStatus, {
    'x-orbitwatch-state': result.response.state,
  });
};

// The Pages runtime type is not shipped with this project's dependencies.
type PagesFunction<Env = unknown> = (context: {
  request: Request;
  env: Env;
  params: Record<string, string>;
  waitUntil: (promise: Promise<unknown>) => void;
  next: () => Promise<Response>;
}) => Response | Promise<Response>;
