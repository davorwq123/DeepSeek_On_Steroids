import metadata from '../../package.json';

/** The package homepage is the one release/feedback authority. An unconfigured fork stays offline. */
export function githubRepository(homepage: unknown): string | null {
  if (typeof homepage !== 'string' || !homepage.trim()) return null;
  try {
    const url = new URL(homepage);
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) return null;
    const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(url.pathname);
    if (!match || ['.', '..'].includes(match[2]!)) return null;
    return `${match[1]}/${match[2]}`;
  } catch { return null; }
}
export const RELEASE_REPOSITORY = githubRepository((metadata as { homepage?: string }).homepage);
export const PROJECT_URL = RELEASE_REPOSITORY ? `https://github.com/${RELEASE_REPOSITORY}` : null;
export const RELEASES_URL = PROJECT_URL ? `${PROJECT_URL}/releases/latest` : '';
