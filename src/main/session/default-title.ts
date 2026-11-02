/** The title a chat carries until its first request names it. */
export const DEFAULT_SESSION_TITLE = 'DeepSeek session';
/** Earlier builds stored this placeholder; it still counts as unnamed. */
const LEGACY_DEFAULT_SESSION_TITLE = 'ChatGPT session';

export function isDefaultSessionTitle(title: string | null | undefined): boolean {
  return title === DEFAULT_SESSION_TITLE || title === LEGACY_DEFAULT_SESSION_TITLE;
}
