/**
 * The one place that knows what a DeepSeek chat URL looks like.
 *
 * The app was written around chatgpt.com; everything here is the DeepSeek equivalent of that
 * boundary. Keeping the shape in one module means the built-in browser, the page driver and
 * the sign-in checks cannot drift apart the way ad-hoc string checks would.
 */

export const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';
export const DEEPSEEK_HOME_URL = `${DEEPSEEK_ORIGIN}/`;
export const DEEPSEEK_SIGN_IN_URL = `${DEEPSEEK_ORIGIN}/sign_in`;

/** `/a/chat/s/<id>` is the current web route; `/chat/s/<id>` and `/s/<id>` are older ones. */
const CONVERSATION_PATHS = [/^\/a\/chat\/s\/([A-Za-z0-9-]{8,128})\/?$/, /^\/chat\/s\/([A-Za-z0-9-]{8,128})\/?$/, /^\/s\/([A-Za-z0-9-]{8,128})\/?$/];

export function isDeepSeekUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === DEEPSEEK_ORIGIN;
  } catch {
    return false;
  }
}

/** The conversation a page is showing, or null on the home, sign-in and share pages. */
export function deepSeekConversationId(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== DEEPSEEK_ORIGIN) return null;
  for (const pattern of CONVERSATION_PATHS) {
    const match = pattern.exec(url.pathname);
    if (match) return match[1] ?? null;
  }
  return null;
}

/** A real chat page: the driver must not type into a welcome, sign-in or shared page. */
export function isDeepSeekChatPage(value: string | null | undefined): boolean {
  return deepSeekConversationId(value) !== null;
}

export function deepSeekConversationUrl(conversationId: string): string {
  return `${DEEPSEEK_ORIGIN}/a/chat/s/${encodeURIComponent(conversationId)}`;
}
