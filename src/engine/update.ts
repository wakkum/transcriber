// The "new version" notice: one request to GitHub for the latest release's version number, compared
// with this app's. Nothing about the user or their files is sent. Any failure (offline, GitHub down)
// is silent.

export const RELEASES_PAGE = 'https://github.com/wakkum/transcriber/releases/latest';
const LATEST_API = 'https://api.github.com/repos/wakkum/transcriber/releases/latest';

const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number);

/** Whether version `latest` (like "v1.2.3") is newer than `current`. Anything unreadable is not newer. */
export function isNewer(latest: string, current: string): boolean {
  const [a, b] = [parse(latest), parse(current)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The newer version's number (like "1.2.3"), or null when up to date or the check could not be made. */
export async function newerVersion(current: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(LATEST_API, { signal, headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', cache: 'no-store' });
    if (!res.ok) return null;
    const tag: unknown = (await res.json()).tag_name;
    return typeof tag === 'string' && isNewer(tag, current) ? tag.trim().replace(/^v/, '') : null;
  } catch {
    return null;
  }
}
