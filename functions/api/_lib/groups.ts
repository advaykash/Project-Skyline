/**
 * Catalogue-group registry and strict allowlist.
 *
 * The group identifier supplied by a client is matched against this registry and
 * nothing else. There is no code path in which user input can influence the
 * upstream URL beyond selecting one of these fixed entries — the application
 * cannot be used as an open proxy.
 */
import catalogGroups from '../../../shared/catalog-groups.json';

export interface GroupDefinition {
  id: string;
  label: string;
  description: string;
  category: string;
  bundle: boolean;
  order: number;
}

const groups = (catalogGroups as GroupDefinition[])
  .slice()
  .sort((a, b) => a.order - b.order);

const byId = new Map(groups.map((g) => [g.id, g]));

export const ALL_GROUPS: GroupDefinition[] = groups;

export function isKnownGroup(id: string): boolean {
  return byId.has(id);
}

export function getGroup(id: string): GroupDefinition | null {
  return byId.get(id) ?? null;
}

/**
 * Build the upstream GP URL for a group. The parameter values are taken from the
 * registry and URL-encoded; `group` is never interpolated from raw user input.
 */
export function upstreamGpUrl(baseUrl: string, group: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=json`;
}
