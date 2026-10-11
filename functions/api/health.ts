/**
 * GET /api/health
 *
 * Structured health and cache metadata for the data pipeline: provider
 * configuration, upstream telemetry, the freshness policy in force, and the
 * per-group state (live / cached / stale / snapshot / unavailable) as derived
 * from actual cache and snapshot metadata.
 */
import { getHealth } from './_lib/service';
import { buildServiceContext, type RuntimeEnv } from './_lib/context';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

export const onRequestGet: PagesFunction<RuntimeEnv> = async (context) => {
  const health = await getHealth(buildServiceContext(context.env));
  return new Response(JSON.stringify(health), {
    status: 200,
    headers: JSON_HEADERS,
  });
};

type PagesFunction<Env = unknown> = (context: {
  request: Request;
  env: Env;
  params: Record<string, string>;
  waitUntil: (promise: Promise<unknown>) => void;
  next: () => Promise<Response>;
}) => Response | Promise<Response>;
