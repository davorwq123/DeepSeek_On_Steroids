/**
 * Setup's first step at startup: read DeepSeek's saved sign-in without opening a browser.
 *
 * The token lives in the page's localStorage, which Chromium exposes only to a document, so this
 * loads DeepSeek's home in one hidden window on the browser's own session and closes it again.
 * Nothing is shown, no tab is created, and it runs once per launch. A later real page read (the
 * host's `readDeepSeekSignIn`, or a sign-out) is newer evidence and is never overwritten here.
 */
import { BrowserWindow } from 'electron';
import { logWarn } from '../logger.js';
import { DEEPSEEK_HOME_URL, isDeepSeekUrl } from '../deepseek/site.js';
import {
  COS_BROWSER_PARTITION,
  DEEPSEEK_SIGNED_IN_CHECK,
  cosBrowserSignedIn,
  setCosBrowserSignedIn
} from './sign-in.js';

/** A home page that has not answered by now is not going to say anything useful this launch. */
const PROBE_TIMEOUT_MS = 15_000;

let probed = false;

/**
 * Answers "is DeepSeek signed in?" from what the profile already holds, before the app shows
 * Setup. Unknown stays unknown when the read fails: no session is not the same as signed out.
 */
export async function probeDeepSeekSignIn(): Promise<void> {
  if (probed || cosBrowserSignedIn() !== null) return;
  probed = true;
  const win = new BrowserWindow({
    width: 480, height: 360, show: false,
    webPreferences: {
      partition: COS_BROWSER_PARTITION, contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false
    }
  });
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (value: boolean | null): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (!win.isDestroyed()) win.destroy();
    // A sign-out that ran during the probe is newer than this page's first read.
    if (value !== null && cosBrowserSignedIn() === null) setCosBrowserSignedIn(value);
  };
  timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The probe never leaves DeepSeek's site; a redirect elsewhere is a page we cannot ask.
  win.webContents.on('will-navigate', (event, target) => { if (!isDeepSeekUrl(target)) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, target) => { if (!isDeepSeekUrl(target)) event.preventDefault(); });
  win.webContents.on('dom-ready', () => {
    if (win.isDestroyed()) return finish(null);
    void win.webContents.executeJavaScript(DEEPSEEK_SIGNED_IN_CHECK)
      .then(value => finish(value === true))
      .catch(() => finish(null));
  });
  win.webContents.on('did-fail-load', () => finish(null));
  void win.loadURL(DEEPSEEK_HOME_URL).catch(error => {
    logWarn(`deepseek sign-in probe: ${error instanceof Error ? error.message : String(error)}`);
    finish(null);
  });
}
