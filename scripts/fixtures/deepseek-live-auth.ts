/**
 * The signed-in DeepSeek page and its session for the live smoke fixtures.
 *
 * The production app owns one browser and its own copied profile. A live smoke runs in a
 * throwaway runtime, so it either inherits the copied cookies/local storage or installs an
 * explicitly exported session. This module only prepares that page; it never touches app history.
 */
import { session } from 'electron';
import fs from 'node:fs/promises';
import type { CosBrowser } from '../../src/main/cos-browser/host.js';
import { DEEPSEEK_SNAPSHOT_SCRIPT, type DeepSeekPageSnapshot } from '../../src/main/deepseek/page.js';
import { DEEPSEEK_HOME_URL } from '../../src/main/deepseek/site.js';

export interface PageContents {
  getURL(): string;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string, world?: boolean): Promise<unknown>;
}

export interface LivePageReport {
  id: number;
  url: string;
  conversationId: string | null;
  signedIn: boolean | null;
  busy: boolean | null;
  commandMarker: string | null;
  inputMarker: string | null;
  messages: number | null;
  hasToken: boolean | null;
  last: Array<{ role: string; text: string }> | null;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until<T>(read: () => T | Promise<T>, label: string, timeout: number): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(500);
  }
  throw new Error(`${label}: ${last instanceof Error ? last.message : 'timed out'}`);
}

/** Every live page owned by the built-in browser, main-window views and background windows. */
export function livePages(browser: CosBrowser): Map<number, PageContents> {
  const views = (browser as unknown as {
    views: Map<number, { webContents: PageContents }>;
    offscreenPages: Map<number, { win: { webContents: PageContents } }>;
  });
  const contents = new Map<number, PageContents>();
  for (const [id, view] of views.views) contents.set(id, view.webContents);
  for (const [id, page] of views.offscreenPages) contents.set(id, page.win.webContents);
  return contents;
}

/** What each app-owned page currently shows, without recording any page text. */
export async function pageDiagnostics(browser: CosBrowser): Promise<LivePageReport[]> {
  const pages: LivePageReport[] = [];
  for (const [id, contentsPage] of livePages(browser)) {
    if (contentsPage.isDestroyed()) continue;
    const url = contentsPage.getURL();
    let snapshot: DeepSeekPageSnapshot | null = null;
    let hasToken: boolean | null = null;
    try {
      snapshot = await contentsPage.executeJavaScript(DEEPSEEK_SNAPSHOT_SCRIPT, true) as DeepSeekPageSnapshot;
      hasToken = await contentsPage.executeJavaScript("!!localStorage.getItem('userToken')", true) as boolean;
    } catch { /* a navigating page has no stable snapshot */ }
    pages.push({
      id, url,
      conversationId: snapshot?.conversationId ?? null,
      signedIn: snapshot?.signedIn ?? null,
      busy: snapshot?.busy ?? null,
      commandMarker: snapshot?.commandMarker ?? null,
      inputMarker: snapshot?.inputMarker ?? null,
      messages: snapshot?.messages.length ?? null,
      hasToken,
      last: snapshot?.messages.slice(-6).map(message => ({ role: message.role, text: message.text.slice(0, 160) })) ?? null
    });
  }
  return pages;
}

export interface SavedSession {
  cookies?: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean;
    httpOnly?: boolean; sameSite?: string; expires?: number; session?: boolean }>;
  storage?: { token?: string | null };
}

export async function readSavedSession(): Promise<SavedSession | null> {
  const file = process.env.COS_DEEPSEEK_SESSION_FILE;
  if (!file) return null;
  return JSON.parse(await fs.readFile(file, 'utf8')) as SavedSession;
}

/**
 * Installs a session exported from a browser the person is already signed in to. This is an
 * opt-in convenience for the live smoke only: the normal path is the app's own copied profile.
 */
export async function installSavedCookies(saved: SavedSession): Promise<void> {
  const ses = session.fromPartition('persist:cos-browser');
  for (const cookie of saved.cookies ?? []) {
    const domain = cookie.domain.replace(/^\./, '');
    const sameSite = cookie.sameSite === 'None' ? 'no_restriction'
      : cookie.sameSite === 'Lax' ? 'lax'
        : cookie.sameSite === 'Strict' ? 'strict' : 'unspecified';
    try {
      await ses.cookies.set({
        url: `https://${domain}${cookie.path ?? '/'}`,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path ?? '/',
        secure: cookie.secure !== false,
        httpOnly: cookie.httpOnly === true,
        sameSite,
        ...(cookie.session || !cookie.expires || cookie.expires < 0 ? {} : { expirationDate: cookie.expires })
      });
    } catch (error) {
      console.error(`DeepSeek cookie ${cookie.name} was refused: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const installed = await ses.cookies.get({ url: DEEPSEEK_HOME_URL }).catch(() => []);
  console.log('Installed DeepSeek cookies:', installed.map(cookie => cookie.name).join(', ') || '(none)');
}

/** The page carries the account token in localStorage; the cookie alone is not the whole session. */
export async function installSavedStorage(browser: CosBrowser, saved: SavedSession): Promise<void> {
  const token = saved.storage?.token;
  if (!token) return;
  // The background window and its view are created asynchronously; setting storage before the
  // view exists silently does nothing, and the page then redirects to sign-in.
  const contents = await until(() => {
    const pages = livePages(browser);
    return [...pages.values()].some(page => !page.isDestroyed() && page.getURL().startsWith('https://chat.deepseek.com')) ? pages : null;
  }, 'DeepSeek page view for the saved token', 20_000);
  if (!contents) throw new Error('No DeepSeek page view appeared for the saved token');
  let installed = 0;
  for (const page of contents.values()) {
    if (page.isDestroyed() || !page.getURL().startsWith('https://chat.deepseek.com')) continue;
    await page.executeJavaScript(`localStorage.setItem('userToken', ${JSON.stringify(token)})`, true).catch(() => undefined);
    installed += 1;
    await page.loadURL(DEEPSEEK_HOME_URL).catch(() => undefined);
  }
  console.log(`Installed the DeepSeek user token in ${installed} page(s).`);
  if (!installed) throw new Error('The saved DeepSeek token was not installed in any page');
}

/**
 * Applies the exported session when present, then proves the page is signed in before a smoke
 * waits on a model. A copied profile can be stale; that is the harness's precondition, not a
 * page-driver failure.
 */
export async function prepareSignedInPage(browser: CosBrowser, openError: string | null): Promise<LivePageReport[]> {
  const supplied = await readSavedSession();
  if (supplied) await installSavedCookies(supplied);
  await browser.start();
  // Do not await the page open itself: a headless or misconfigured display can leave a
  // WebContents request pending forever. The bounded sign-in poll below still fails honestly.
  void browser.ensureBackground(DEEPSEEK_HOME_URL, {}).catch(error => {
    openError = openError ?? (error instanceof Error ? error.message : String(error));
  });
  if (supplied) await installSavedStorage(browser, supplied);
  // The home URL answers before DeepSeek decides whether to redirect to sign-in. Only the
  // page's own final URL and snapshot prove the account; `cosBrowserSignedIn()` alone is a
  // URL guess that a signed-out visitor passes on the first frame.
  await delay(5_000);
  const signed = await until(async () => {
    const pages = await pageDiagnostics(browser);
    return pages.find(page => page.signedIn === true && page.hasToken === true && !page.url.includes('/sign_in')) ? pages : null;
  }, 'DeepSeek sign-in page', 20_000).catch(() => null);
  if (!signed) {
    const pages = await pageDiagnostics(browser);
    throw new Error(`The copied browser profile is signed out of DeepSeek${openError ? `: ${openError}` : ''}. ` +
      `Pages: ${JSON.stringify(pages.map(page => ({ url: page.url, signedIn: page.signedIn, hasToken: page.hasToken })))}`);
  }
  return signed;
}
