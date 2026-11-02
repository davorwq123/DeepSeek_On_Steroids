/**
 * A one-off DeepSeek chat for the app's own questions: a Plan draft, or a Goal/Loop decision made
 * in a separate chat. ChatGPT ran these in a Temporary Chat its page driver opened; DeepSeek has
 * no temporary chats, and the page driver deliberately ignores helper rows so they never become
 * the person's conversation. This opens one hidden window on the browser's own signed-in
 * session, sends the prompt to a new chat, reads the finished answer from DeepSeek's raw history
 * (never rendered Markdown), and deletes that chat again so it does not clutter the sidebar.
 *
 * The window is not a tab: the host does not list it, the page driver never sees it, and nothing
 * here records a session.
 */
import { BrowserWindow } from 'electron';
import { logInfo, logWarn } from '../logger.js';
import { COS_BROWSER_PARTITION } from '../cos-browser/sign-in.js';
import {
  DEEPSEEK_SNAPSHOT_SCRIPT,
  deepSeekHistoryScript,
  deepSeekSendScript,
  type DeepSeekHistoryResult,
  type DeepSeekPageSnapshot,
  type DeepSeekSendResult,
  type DeepSeekSendSelection
} from './page.js';
import { DEEPSEEK_HOME_URL, isDeepSeekUrl } from './site.js';
import { markDeepSeekHelperContents } from './helper-contents.js';

/** The little the helper needs from a page; Electron in the app, a fake in tests. */
export interface HelperPage {
  run<T>(script: string): Promise<T>;
  close(): void;
}
export type HelperPageFactory = (url: string, signal: AbortSignal) => Promise<HelperPage>;

export interface HelperChatOptions extends DeepSeekSendSelection {
  /** Streamed answer text, for progress only. */
  publish?: (text: string) => void;
  /** Called when the request is cancelled after DeepSeek took the prompt but before it answered. */
  onSentUnanswered?: () => void;
}

const POLL_MS = 700;
const READY_MS = 20_000;
/** DeepSeek gives a new chat its id once it takes the question. */
const STARTED_MS = 20_000;
/** Terminal history states other than FINISHED: the answer stopped and will not complete. */
const STOPPED = new Set(['INCOMPLETE', 'FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'STOPPED']);
/** One helper chat at a time: two hidden pages would compete for DeepSeek's rate window. */
let queue: Promise<unknown> = Promise.resolve();

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
  if (signal.aborted) return stop();
  signal.addEventListener('abort', stop, { once: true });
});

/** Deletes a helper chat through DeepSeek's own API, with the page's own token. */
export function deepSeekDeleteChatScript(conversationId: string): string {
  return `(async () => {
  try {
    const token = JSON.parse(localStorage.getItem('userToken') || 'null')?.value;
    if (typeof token !== 'string' || !token) return false;
    const response = await fetch('/api/v0/chat_session/delete', {
      method: 'POST', credentials: 'include',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_session_id: ${JSON.stringify(conversationId)} })
    });
    const body = await response.json().catch(() => null);
    return response.ok && body?.code === 0;
  } catch { return false; }
})()`;
}

/** Sends `prompt` to a new hidden DeepSeek chat and returns its finished answer text. */
export function askDeepSeekHelper(prompt: string, signal: AbortSignal, options: HelperChatOptions = {},
  open: HelperPageFactory = openHiddenPage): Promise<string> {
  const turn = queue.then(() => runHelper(prompt, signal, options, open));
  queue = turn.catch(() => undefined);
  return turn;
}

async function runHelper(prompt: string, signal: AbortSignal, options: HelperChatOptions, open: HelperPageFactory): Promise<string> {
  signal.throwIfAborted();
  const page = await open(DEEPSEEK_HOME_URL, signal);
  let conversationId: string | null = null;
  let taken = false;
  try {
    const ready = Date.now() + READY_MS;
    for (;;) {
      const snapshot = await page.run<DeepSeekPageSnapshot>(DEEPSEEK_SNAPSHOT_SCRIPT);
      if (snapshot.signedIn && snapshot.composerReady && !snapshot.conversationId && !snapshot.busy) break;
      if (Date.now() > ready) throw new Error(snapshot.signedIn ? 'helper_page_not_ready' : 'deepseek_signed_out');
      await pause(POLL_MS, signal);
    }
    const sent = await page.run<DeepSeekSendResult>(deepSeekSendScript(prompt, { model: options.model, reasoningEffort: options.reasoningEffort }));
    if (!sent.ok) throw new Error(`helper_send_failed: ${sent.reason}`);
    taken = true;
    const started = Date.now() + STARTED_MS;
    while (!conversationId) {
      await pause(POLL_MS, signal);
      conversationId = (await page.run<DeepSeekPageSnapshot>(DEEPSEEK_SNAPSHOT_SCRIPT)).conversationId;
      if (!conversationId && Date.now() > started) throw new Error('helper_chat_not_started');
    }
    let shown = '';
    for (;;) {
      const history = await page.run<DeepSeekHistoryResult>(deepSeekHistoryScript(conversationId));
      if (history.ok && history.role === 'ASSISTANT') {
        if (history.text !== shown) { shown = history.text; options.publish?.(shown); }
        if (history.status === 'FINISHED' && !history.pending) {
          if (!history.text.trim()) throw new Error('helper_empty_answer');
          return history.text;
        }
        if (STOPPED.has(history.status.toUpperCase())) throw new Error('helper_answer_incomplete');
      }
      await pause(POLL_MS, signal);
    }
  } catch (error) {
    // A fixed stage code is useful diagnostics; never log the prompt, answer or provider token.
    const message = error instanceof Error ? error.message : '';
    const code = /^(?:helper_[a-z_]+|deepseek_signed_out)(?=:|$)/.exec(message)?.[0]
      ?? (signal.aborted ? 'cancelled' : 'page_error');
    logWarn(`deepseek helper: failed (${code})`);
    if (taken && signal.aborted) options.onSentUnanswered?.();
    throw error;
  } finally {
    if (conversationId) {
      const id = conversationId;
      // Best effort, and never on the caller's clock: a cancelled request still tidies up.
      await page.run<boolean>(deepSeekDeleteChatScript(id))
        .then(deleted => { if (!deleted) logWarn(`deepseek helper: could not delete helper chat ${id}`); })
        .catch(() => logWarn(`deepseek helper: could not delete helper chat ${id}`));
    }
    page.close();
  }
}

/** One hidden window on the in-app browser's session, kept on DeepSeek's site. */
async function openHiddenPage(url: string, signal: AbortSignal): Promise<HelperPage> {
  const win = new BrowserWindow({
    width: 1100, height: 800, show: false,
    webPreferences: { partition: COS_BROWSER_PARTITION, offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  // Before anything loads: the page driver checks this on every navigation.
  markDeepSeekHelperContents(win.webContents);
  const close = () => {
    signal.removeEventListener('abort', close);
    if (!win.isDestroyed()) win.destroy();
  };
  signal.addEventListener('abort', close, { once: true });
  // DeepSeek mounts its composer after layout. Keep frames flowing in an invisible renderer.
  win.webContents.on('paint', () => {});
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => { if (!isDeepSeekUrl(target)) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, target) => { if (!isDeepSeekUrl(target)) event.preventDefault(); });
  try {
    signal.throwIfAborted();
    await win.loadURL(url);
    signal.throwIfAborted();
  } catch (error) {
    close();
    signal.throwIfAborted();
    throw error;
  }
  logInfo('deepseek helper: opened a hidden helper chat');
  return {
    run: script => win.isDestroyed() ? Promise.reject(new Error('helper_page_closed')) : win.webContents.executeJavaScript(script),
    close
  };
}
