import { FALLBACK_TAG, LATEST_RELEASE_URL, REPO_URL } from '../data/site';
import releaseInfo from '../data/release.json';
import type { PublishedRelease, ReleaseAsset } from '../hooks/useRepo';

/* Server-safe, serializable release data. The first HTML byte already carries
   the right version, download links, and changelog — crawlers never see an
   empty shell. Client hooks upgrade to live GitHub data after hydration.
   NOTE: no functions here — server components must only pass plain JSON to
   client components. Use assetUrl() at the call site instead. */

export type SerializableRelease = {
  tag: string;
  short: string;
  assets: ReleaseAsset[];
};

export function assetUrl(
  rel: Pick<SerializableRelease, 'tag' | 'short' | 'assets'>,
  match: (name: string) => boolean,
  fallbackFile: string,
): string {
  const found = rel.assets.find((a) => match(a.name))?.url;
  if (found) return found;
  const { tag, short } = rel;
  const file = fallbackFile.includes(short) ? fallbackFile : fallbackFile.replace(/\d+\.\d+\.\d+/, short);
  return `${REPO_URL}/releases/download/${tag}/${file}`;
}

export function getServerRelease(): SerializableRelease {
  const tag = releaseInfo.tag ?? FALLBACK_TAG;
  const short = tag.replace(/^v/, '');
  return { tag, short, assets: [] };
}

export function getServerReleases(limit = 20): PublishedRelease[] {
  const list = (releaseInfo.releases ?? []) as PublishedRelease[];
  return list.slice(0, limit);
}

export { LATEST_RELEASE_URL };
