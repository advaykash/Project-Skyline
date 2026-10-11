/**
 * Bundled offline snapshot access.
 *
 * The snapshot lives in `data/snapshot/` and is published as static assets at
 * `/snapshot/…`. The Functions read it through an injected asset loader — in
 * production that is the Cloudflare Pages `ASSETS` binding; in tests it is a
 * file reader. The loader interface keeps the service code environment-agnostic.
 *
 * Every snapshot response is labelled `state: "snapshot"` and carries the real
 * capture time from the manifest. Snapshot records are never presented as live.
 */

export interface SnapshotGroupEntry {
  recordCount: number;
  bytes: number;
  sha256: string;
  capturedAt: string;
  sourceUrl: string;
  via: string;
  epochRange: { min: string; max: string };
}

export interface SnapshotManifest {
  schema: string;
  generatedAt: string;
  generatedBy: string;
  provider: string;
  providerEndpoint: string;
  providerDocs: string;
  usagePolicy: string;
  note: string;
  groups: Record<string, SnapshotGroupEntry>;
}

/** Reads a static asset by URL path (e.g. `/snapshot/manifest.json`). */
export type AssetLoader = (path: string) => Promise<string | null>;

export async function loadSnapshotManifest(assets: AssetLoader): Promise<SnapshotManifest | null> {
  const text = await assets('/snapshot/manifest.json');
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as SnapshotManifest;
    return parsed && typeof parsed === 'object' && parsed.groups ? parsed : null;
  } catch {
    return null;
  }
}

export interface SnapshotPayload {
  text: string;
  manifest: SnapshotGroupEntry;
  generatedAt: string;
}

/** Load one group's verbatim records from the bundled snapshot. */
export async function loadSnapshotGroup(
  assets: AssetLoader,
  manifest: SnapshotManifest,
  group: string,
): Promise<SnapshotPayload | null> {
  const entry = manifest.groups[group];
  if (!entry) return null;
  const text = await assets(`/snapshot/groups/${group}.json`);
  if (!text) return null;
  return { text, manifest: entry, generatedAt: manifest.generatedAt };
}
