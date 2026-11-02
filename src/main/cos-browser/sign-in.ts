/**
 * Whether the CoS browser holds a provider sign-in, for Setup's first step.
 *
 * Kept apart from the host so the app's state can read it without loading Electron's browser
 * machinery. DeepSeek's host, startup probe and page polls share the token check below;
 * null until one of them has read it.
 */
let signedIn: boolean | null = null;
const listeners = new Set<() => void>();

/** The app-owned browser's own Chromium session; every page it shows shares cookies and storage. */
export const COS_BROWSER_PARTITION = 'persist:cos-browser';

/**
 * DeepSeek's own token is the only proof of a session. Its sign-in page stores
 * `userToken: { value: null }`, so a path such as /sign_up is not a sign-in.
 */
export const DEEPSEEK_SIGNED_IN_CHECK = `(() => {
  try {
    const raw = localStorage.getItem('userToken');
    if (!raw) return false;
    const token = JSON.parse(raw);
    return typeof token?.value === 'string' && token.value.length > 0;
  } catch { return false; }
})()`;

/** ChatGPT's session cookie, which it splits into numbered chunks when it grows. */
export const CHATGPT_SESSION_COOKIE = /^__Secure-next-auth\.session-token(?:\.\d+)?$/;

/** The exact HTTPS Google login host; the owning provider decides how the browser handles it. */
export function isGoogleSignIn(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'accounts.google.com';
  } catch { return false; }
}

/**
 * A provider window DeepSeek's sign-in page opens for itself. It stays in this browser's own
 * session: the login must finish here, because this fork has no extension to carry one back.
 */
export function isOAuthSignIn(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'accounts.google.com' || host === 'appleid.apple.com';
  } catch { return false; }
}

export function cosBrowserSignedIn(): boolean | null {
  return signedIn;
}

export function setCosBrowserSignedIn(next: boolean | null): void {
  if (next === signedIn) return;
  signedIn = next;
  for (const listener of listeners) listener();
}

export function onCosBrowserSignInChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
