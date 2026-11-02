import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
  interface FakeContents extends EventEmitter {
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    executeJavaScript: ReturnType<typeof vi.fn>;
  }
  interface FakeOptions {
    show?: boolean;
    webPreferences?: { partition?: string };
  }
  interface FakeWindow {
    webContents: FakeContents;
    options: FakeOptions;
    destroyed: boolean;
    loadURL: (url: string) => Promise<void>;
    destroy: () => void;
    isDestroyed: () => boolean;
  }
  const windows: FakeWindow[] = [];
  class FakeWindowImpl implements FakeWindow {
    webContents: FakeContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async (): Promise<unknown> => false)
    });
    destroyed = false;
    loadURL = vi.fn(async () => {});
    destroy = vi.fn(() => { this.destroyed = true; });
    isDestroyed = (): boolean => this.destroyed;
    constructor(public options: FakeOptions) { windows.push(this); }
  }
  return { windows, FakeWindowImpl };
});

vi.mock('electron', () => ({ BrowserWindow: native.FakeWindowImpl }));
vi.mock('../src/main/logger.js', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }));

/** A fresh module graph, because the probe remembers that it already ran this launch. */
async function start() {
  vi.resetModules();
  const signIn = await import('../src/main/cos-browser/sign-in.js');
  const probe = await import('../src/main/cos-browser/sign-in-probe.js');
  const site = await import('../src/main/deepseek/site.js');
  return { signIn, probe, site };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => { native.windows.length = 0; });

it('reads the saved sign-in from one hidden page, then closes it', async () => {
  const { signIn, probe, site } = await start();
  const run = probe.probeDeepSeekSignIn();
  const win = native.windows[0]!;
  win.webContents.executeJavaScript.mockResolvedValue(true);
  win.webContents.emit('dom-ready');
  await run;
  await settle();
  expect(win.options.show).toBe(false);
  expect(win.options.webPreferences?.partition).toBe(signIn.COS_BROWSER_PARTITION);
  expect(signIn.cosBrowserSignedIn()).toBe(true);
  expect(win.destroy).toHaveBeenCalledTimes(1);
  expect(win.loadURL).toHaveBeenCalledWith(site.DEEPSEEK_HOME_URL);
  expect(win.webContents.executeJavaScript).toHaveBeenCalledWith(signIn.DEEPSEEK_SIGNED_IN_CHECK);
});

it('reads a signed-out profile as signed out, so Setup does not stay unknown', async () => {
  const { signIn, probe } = await start();
  const run = probe.probeDeepSeekSignIn();
  native.windows[0]!.webContents.executeJavaScript.mockResolvedValue(false);
  native.windows[0]!.webContents.emit('dom-ready');
  await run;
  await settle();
  expect(signIn.cosBrowserSignedIn()).toBe(false);
});

it('leaves an unreadable page unknown instead of claiming a sign-out', async () => {
  const { signIn, probe } = await start();
  const run = probe.probeDeepSeekSignIn();
  const win = native.windows[0]!;
  win.webContents.executeJavaScript.mockRejectedValue(new Error('page gone'));
  win.webContents.emit('dom-ready');
  await run;
  await settle();
  expect(signIn.cosBrowserSignedIn()).toBeNull();
  expect(win.destroy).toHaveBeenCalled();
});

it('keeps a newer sign-out that happened while the probe was reading', async () => {
  const { signIn, probe } = await start();
  const run = probe.probeDeepSeekSignIn();
  const win = native.windows[0]!;
  win.webContents.executeJavaScript.mockResolvedValue(true);
  signIn.setCosBrowserSignedIn(false);
  win.webContents.emit('dom-ready');
  await run;
  await settle();
  expect(signIn.cosBrowserSignedIn()).toBe(false);
});

it('does not start a page when the app already knows the answer, or twice in one launch', async () => {
  const { signIn, probe } = await start();
  signIn.setCosBrowserSignedIn(false);
  await probe.probeDeepSeekSignIn();
  expect(native.windows).toHaveLength(0);

  const fresh = await start();
  const first = fresh.probe.probeDeepSeekSignIn();
  native.windows[0]!.webContents.executeJavaScript.mockResolvedValue(true);
  native.windows[0]!.webContents.emit('dom-ready');
  await first;
  await settle();
  await fresh.probe.probeDeepSeekSignIn();
  expect(native.windows).toHaveLength(1);
});
