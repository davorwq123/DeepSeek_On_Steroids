/** Explicit desktop sends open the DeepSeek page they belong to. */
import { resetBrowserStartupForTests } from '../browser-startup.js';
import { ensureDeepSeekPage } from '../deepseek/browser.js';
import { cosBrowserSignedIn, onCosBrowserSignInChange } from '../cos-browser/sign-in.js';
import { logWarn } from '../logger.js';
import { SIGN_IN_PREFIX } from '../../shared/input.js';
import { enqueueInput, cancelInput, listInputs, noteInputStartupError, type InputArgs, type InputEntry } from './input.js';

function wakeBrowser(entry: InputEntry): Promise<void> {
  return ensureDeepSeekPage(entry.conversationId ? { conversationId: entry.conversationId } : { inputId: entry.id });
}
/**
 * Connection setup, not the browser, stopped this send (#882 VM test, 2026-10-04: a fresh install
 * said "Browser startup failed: Add a folder before connecting"). Its own prefix says what to do;
 * retry accepts both, so the message still goes out once Setup is done.
 */
const SETUP_PREFIX = 'Message queued. Finish Setup to send: ';
const BROWSER_PREFIX = 'Message queued. Browser startup failed: ';
class SetupNotReady extends Error {}
const startupError = (error: unknown): string =>
  (error as Error).message?.startsWith(SIGN_IN_PREFIX) ? (error as Error).message :
    (error instanceof SetupNotReady ? SETUP_PREFIX : BROWSER_PREFIX) + (error as Error).message;

/**
 * DeepSeek executes in this app's own browser; the MCP tunnel and a paired extension are not
 * needed to send a message. The page opener starts the browser and opens the exact page, and
 * the page driver owns delivery from there.
 */
async function ready(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
}
async function deliver(entry: InputEntry): Promise<InputEntry> {
  try {
    await wakeBrowser(entry);
    return await noteInputStartupError(entry.id, null) ?? entry;
  } catch (error) {
    return await noteInputStartupError(entry.id, startupError(error)) ?? entry;
  }
}
// Only transient startup work lives here; the outbox owns accepted messages.
const starting = new Map<string, AbortController>();
let stopped = false;
let stopSignInRetry: (() => void) | null = null;
let signInRetries = Promise.resolve();
function retrySignInInputs(): void {
  if (!stopSignInRetry || stopped || cosBrowserSignedIn() !== true) return;
  signInRetries = signInRetries.then(async () => {
    const waiting = (await listInputs()).filter(row => row.state === 'queued' && row.error?.startsWith(SIGN_IN_PREFIX))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const row of waiting) {
      if (stopped || cosBrowserSignedIn() !== true) break;
      await retryQueuedInputBrowser(row.id);
    }
  }).catch(error => logWarn(`input sign-in retry failed: ${(error as Error).message}`));
}
/** One listener resumes only the outbox rows explicitly held for sign-in. */
export function startInputSignInRetry(): void {
  if (stopSignInRetry || stopped) return;
  stopSignInRetry = onCosBrowserSignInChange(retrySignInInputs);
  retrySignInInputs();
}
export async function cancelDesktopInput(id: string): Promise<boolean> {
  const start = starting.get(id);
  start?.abort(new Error('Input cancelled'));
  return await cancelInput(id) || !!start;
}
async function startAcceptedInput(entry: InputEntry, controller: AbortController): Promise<void> {
  const signedInAtStart = cosBrowserSignedIn();
  try {
    await ready(controller.signal);
    controller.signal.throwIfAborted();
    const current = (await listInputs()).find(row => row.id === entry.id);
    controller.signal.throwIfAborted();
    if (current?.state === 'queued') await deliver(current);
  } catch (error) {
    if (!controller.signal.aborted) await noteInputStartupError(entry.id, startupError(error));
  } finally {
    if (starting.get(entry.id) === controller) starting.delete(entry.id);
    // Sign-in can finish while the opener is still publishing its waiting reason.
    if (!controller.signal.aborted && signedInAtStart !== true) retrySignInInputs();
  }
}
export async function sendDesktopInput(input: InputArgs): Promise<InputEntry> {
  if (stopped) throw new Error('The app is shutting down');
  if (input.mode === 'finish' || starting.has(input.id)) return enqueueInput(input);
  const controller = new AbortController(); starting.set(input.id, controller);
  try {
    const entry = await enqueueInput(input);
    if (controller.signal.aborted) { await cancelInput(input.id); controller.signal.throwIfAborted(); }
    if (entry.state !== 'queued' || entry.transportIntent === 'tool' || entry.attachmentDelivery === 'tool') {
      starting.delete(input.id); return entry;
    }
    // Return after durable admission, not after connection startup or native delivery.
    void startAcceptedInput(entry, controller).catch(() => undefined);
    return entry;
  } catch (error) {
    if (starting.get(input.id) === controller) starting.delete(input.id);
    throw error;
  }
}
export function stopInputStartup(): void {
  stopped = true;
  stopSignInRetry?.(); stopSignInRetry = null;
  for (const controller of starting.values()) controller.abort(new Error('The app is shutting down'));
  starting.clear();
}
export async function retryQueuedInputBrowser(id: string): Promise<InputEntry | null> {
  if (stopped || starting.has(id)) return null;
  const eligible = (entry: InputEntry | undefined): entry is InputEntry => !!entry && entry.state === 'queued' && entry.purpose !== 'decision' && !!(entry.error?.startsWith(SIGN_IN_PREFIX) || entry.error?.startsWith(BROWSER_PREFIX) || entry.error?.startsWith(SETUP_PREFIX) || entry.error?.startsWith('Local chat setup failed:'));
  if (!eligible((await listInputs()).find(entry => entry.id === id)) || stopped || starting.has(id)) return null;
  const controller = new AbortController(); starting.set(id, controller);
  const signedInAtStart = cosBrowserSignedIn();
  try {
    const repaired = await noteInputStartupError(id, null);
    if (repaired?.error?.startsWith('Local chat setup failed:')) return repaired;
    await ready(controller.signal);
    const entry = (await listInputs()).find(row => row.id === id);
    controller.signal.throwIfAborted();
    return entry?.state === 'queued' ? await deliver(entry) : null;
  } catch (error) {
    if (controller.signal.aborted) return null;
    return await noteInputStartupError(id, startupError(error));
  } finally {
    if (starting.get(id) === controller) starting.delete(id);
    if (!controller.signal.aborted && signedInAtStart !== true) retrySignInInputs();
  }
}
export function resetInputStartupForTests(): void { stopInputStartup(); stopped = false; resetBrowserStartupForTests(); }
