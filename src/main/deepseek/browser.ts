/**
 * Opening the DeepSeek page a message belongs to.
 *
 * Chat On Steroids' ChatGPT transport asked a companion extension to find or open a tab. This
 * fork owns a browser instead, so the app can do that itself: an existing chat reuses the tab
 * already showing it, and a new chat opens a fresh page carrying the exact outbox marker the
 * page driver claims. Nothing here depends on the MCP tunnel or the extension bridge; a send
 * must work on a fresh install that has only signed in to DeepSeek.
 */

import { getConfig } from '../config.js';
import { cosBrowserSignedIn } from '../cos-browser/sign-in.js';
import { loadCosBrowser } from '../cos-browser/selection.js';
import { DEEPSEEK_HOME_URL, deepSeekConversationUrl } from './site.js';
import { SIGN_IN_WAITING } from '../../shared/input.js';

/** The home URL that names one exact pending opening for the page driver. */
export function deepSeekOpeningUrl(inputId: string): string {
  const marker = `cos-input=${encodeURIComponent(inputId)}`;
  return `${DEEPSEEK_HOME_URL}?${marker}#${marker}`;
}

/**
 * Opens (or reuses) the page for one outbox row. A conversation id targets that chat; without
 * one the page is a new chat marked for exactly this row, so it can never type into a chat
 * somebody else owns.
 */
export async function ensureDeepSeekPage(target: {
  conversationId?: string | null;
  inputId?: string;
}): Promise<void> {
  const browser = await loadCosBrowser();
  // Background chats is the person's choice: off means a send may bring the chat forward.
  const reveal = getConfig().ui.backgroundChats === false;
  // A known signed-out browser is not a delivery failure to hide: bring its login forward
  // and let the outbox say what to do. Unknown state is allowed to proceed; the page itself
  // will show its sign-in route and the driver refuses to type there.
  if (cosBrowserSignedIn() === false) {
    await browser.showSignIn();
    throw new Error(SIGN_IN_WAITING);
  }
  if (target.conversationId) {
    await browser.ensureBackground(deepSeekConversationUrl(target.conversationId), {
      conversationId: target.conversationId
    }, reveal);
    return;
  }
  if (!target.inputId) return;
  const marker = `cos-input=${encodeURIComponent(target.inputId)}`;
  await browser.ensureBackground(deepSeekOpeningUrl(target.inputId), { marker }, reveal);
}
