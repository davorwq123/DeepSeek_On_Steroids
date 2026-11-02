import type { WebContents } from 'electron';

/**
 * The hidden windows the app opens for its own helper chats (helper-chat.ts). They are DeepSeek
 * pages, so the page driver would otherwise adopt them, record their chat as a session and
 * deliver queued messages into it.
 */
const helpers = new WeakSet<WebContents>();

export function markDeepSeekHelperContents(contents: WebContents): void { helpers.add(contents); }
export function isDeepSeekHelperContents(contents: WebContents): boolean { return helpers.has(contents); }
