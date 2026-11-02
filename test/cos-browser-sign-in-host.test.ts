import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
  const fakeContents = () => Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(), loadURL: vi.fn(async () => {}), loadFile: vi.fn(async () => {}), send: vi.fn(),
    executeJavaScript: vi.fn(async (_code: string): Promise<unknown> => false), focus: vi.fn(), close: vi.fn(), isDestroyed: () => false
  });
  const panels: Array<{ webContents: ReturnType<typeof fakeContents> }> = [];
  class WebContentsView {
    webContents = fakeContents();
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    setVisible = vi.fn();
    constructor() { panels.push(this); }
  }
  return { panels, WebContentsView, open: vi.fn(async () => 'edge'), dialog: vi.fn(async () => ({ response: 0 })),
    icon: vi.fn(async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AA==' })),
    thumbnail: vi.fn(async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AA==' })) };
});
vi.mock('electron', () => ({ BaseWindow: class {}, BrowserWindow: class {}, WebContentsView: native.WebContentsView, nativeTheme: { shouldUseDarkColors: false },
  app: { getFileIcon: native.icon, once: vi.fn(),
    userAgentFallback: 'Mozilla/5.0 Chrome/150.0.0.0 Electron/44.3.0 deepseek-on-steroids/2.1.47 Safari/537.36' },
  dialog: { showMessageBox: native.dialog }, nativeImage: { createThumbnailFromPath: native.thumbnail }, session: {}, shell: {} }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { chatBrowser: 'cos', language: 'pt-BR' } }) }));
vi.mock('../src/main/browser.js', () => ({
  installedSignInBrowsers: () => process.platform === 'darwin'
    ? [{ browser: 'chrome', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { browser: 'edge', executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' }]
    : [{ browser: 'chrome', executable: 'chrome.exe' }, { browser: 'edge', executable: 'msedge.exe' }],
  openBrowserSignIn: native.open, EXTERNAL_BROWSER_LABELS: { chrome: 'Chrome', edge: 'Edge', brave: 'Brave' }
}));
const { CosBrowser, browserIcon } = await import('../src/main/cos-browser/host.js');
const { cosSignInTransfer } = await import('../src/main/cos-browser/sign-in-transfer.js');
const { cosBrowserSignedIn, setCosBrowserSignedIn, onCosBrowserSignInChange } = await import('../src/main/cos-browser/sign-in.js');

afterEach(() => {
  cosSignInTransfer.cancel();
  native.open.mockReset();
  native.open.mockImplementation(async () => 'edge');
  native.dialog.mockReset();
  native.dialog.mockImplementation(async () => ({ response: 0 }));
  native.panels.length = 0;
  native.icon.mockClear();
  native.thumbnail.mockClear();
  setCosBrowserSignedIn(null);
});

it('takes a browser\'s icon from its app bundle on macOS, where the file icon call ends the app', async () => {
  // macOS 27: app.getFileIcon traps on a worker thread and the whole app quits (any path).
  await browserIcon('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'darwin');
  expect(native.thumbnail).toHaveBeenCalledWith('/Applications/Google Chrome.app', { width: 64, height: 64 });
  await browserIcon('/Users/someone/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'darwin');
  expect(native.thumbnail).toHaveBeenLastCalledWith('/Users/someone/Applications/Brave Browser.app', { width: 64, height: 64 });
  await expect(browserIcon('/usr/local/bin/chromium', 'darwin')).rejects.toThrow('not inside an app bundle');
  expect(native.icon).not.toHaveBeenCalled();
  // Elsewhere the file icon stays: it is what the taskbar shows.
  await browserIcon('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'win32');
  expect(native.icon).toHaveBeenCalledWith('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', { size: 'large' });
  expect(native.thumbnail).toHaveBeenCalledTimes(2);
});

function browserFixture(url = 'https://auth.openai.com/log-in') {
  const host = new CosBrowser({ preloadDir: 'unused', rendererUrl: () => null, rendererDir: 'unused' }) as any;
  const windowId = host.model.createWindow({ type: 'normal', state: 'normal' });
  const base = {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }),
    isDestroyed: () => false, isMinimized: () => false, isMaximized: () => false, isFocused: () => false, isVisible: () => true,
    show: vi.fn(), showInactive: vi.fn(), focus: vi.fn(), restore: vi.fn(), setTitle: vi.fn(), destroy: vi.fn()
  };
  host.frames.set(windowId, { id: windowId, base, toolbar: { setBounds: vi.fn(), webContents: { isDestroyed: () => true, close: vi.fn() } }, shown: false, overlay: '' });
  const contents = Object.assign(new EventEmitter(), { id: 41, isDestroyed: (): boolean => false,
    debugger: Object.assign(new EventEmitter(), { isAttached: () => false }),
    loadURL: vi.fn(async (_url: string) => {}), setUserAgent: vi.fn(), setWindowOpenHandler: vi.fn(), focus: vi.fn(), getURL: () => url,
    executeJavaScript: vi.fn(async (_code: string): Promise<unknown> => false) });
  contents.on('did-navigate', (_event, next: string) => { url = next; });
  host.ses = { cookies: {} };
  host.views.set(contents.id, { webContents: contents, setBounds: vi.fn(), setVisible: vi.fn() });
  host.model.addTab(contents.id, windowId, { url, active: true });
  return { host, contents, base };
}

function configureSession(host: any) {
  const ses = {
    setUserAgent: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), registerPreloadScript: vi.fn(),
    cookies: new EventEmitter(), serviceWorkers: new EventEmitter(), webRequest: { onBeforeSendHeaders: vi.fn() }
  };
  host.configure(ses);
  return ses;
}

const chromiumAgent = 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36';
const firefoxAgent = `Mozilla/5.0 (${process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
  : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10.15' : 'X11; Linux x86_64'}; rv:140.0) Gecko/20100101 Firefox/140.0`;

/** The last state the panel page was sent. */
const panelState = (panel = native.panels.at(-1)!) => panel.webContents.send.mock.calls.at(-1)?.[1];
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it('covers the Google tab with one CoS panel and opens only the browser the person chose', async () => {
  const { host, contents, base } = browserFixture();
  host.wire(contents);
  const event = { preventDefault: vi.fn(), isMainFrame: true };
  contents.emit('will-redirect', event, 'https://accounts.google.com/v3/signin/identifier');
  contents.emit('will-navigate', event, 'https://accounts.google.com/v3/signin/identifier');
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(native.panels).toHaveLength(1);
  const [panel] = native.panels;
  expect(base.contentView.addChildView).toHaveBeenCalledWith(panel);
  expect(panel!.webContents.loadFile).toHaveBeenCalledWith(expect.stringContaining('cos-browser-sign-in.html'));
  // Nothing opens, and no offer exists, until the person picks a browser.
  expect(native.open).not.toHaveBeenCalled();
  expect(cosSignInTransfer.pending()).toBeNull();
  await settle();
  expect(panelState()).toMatchObject({ phase: 'choose', language: 'pt-BR',
    browsers: [{ id: 'chrome', label: 'Chrome', icon: 'data:image/png;base64,AA==' }, { id: 'edge', label: 'Edge' }] });

  host.signInAction(contents, 'choose', 'edge');
  host.signInAction(panel!.webContents, 'choose', 'brave');
  expect(native.open).not.toHaveBeenCalled();
  host.signInAction(panel!.webContents, 'choose', 'edge');
  await settle();
  expect(native.open).toHaveBeenCalledExactlyOnceWith('edge');
  expect(cosSignInTransfer.pending()?.browser).toBe('edge');
  expect(panelState()).toMatchObject({ phase: 'waiting', browser: 'edge', launching: false, notice: null });

  // Opening again keeps the same offer; a later redirect finds the panel already open.
  const offer = cosSignInTransfer.pending()!.id;
  host.signInAction(panel!.webContents, 'reopen');
  await settle();
  expect(native.open).toHaveBeenCalledTimes(2);
  expect(cosSignInTransfer.pending()?.id).toBe(offer);
  contents.emit('will-redirect', event, 'https://accounts.google.com/');
  expect(native.panels).toHaveLength(1);
});

it.each(['will-navigate', 'will-redirect'])('reloads DeepSeek\'s Google %s with Firefox before the first request, without a dialog', async eventName => {
  const { host, contents } = browserFixture('https://chat.deepseek.com/sign_in');
  host.wire(contents);
  contents.emit('did-navigate', {}, 'https://chat.deepseek.com/sign_in');
  const event = { preventDefault: vi.fn(), isMainFrame: true };
  const googleUrl = 'https://accounts.google.com/v3/signin/identifier';
  const requests: Array<{ agent: unknown; cancellations: number }> = [];
  contents.loadURL.mockImplementation(async () => {
    requests.push({ agent: contents.setUserAgent.mock.lastCall?.[0], cancellations: event.preventDefault.mock.calls.length });
    // A navigation started by the host and Google's subsequent redirects must go through.
    contents.emit('will-navigate', event, googleUrl);
  });
  contents.emit(eventName, event, googleUrl);
  contents.emit('did-navigate', {}, googleUrl);
  contents.emit('will-redirect', event, 'https://accounts.google.com/o/oauth2/v2/auth');
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  expect(contents.loadURL).toHaveBeenCalledExactlyOnceWith(googleUrl);
  expect(requests).toEqual([{ agent: firefoxAgent, cancellations: 1 }]);
  expect(contents.setUserAgent).toHaveBeenCalledExactlyOnceWith(firefoxAgent);
  expect(native.panels).toHaveLength(0);
  await settle();
  expect(native.dialog).not.toHaveBeenCalled();
});

it('restores Chromium when Google returns to DeepSeek and reads the DeepSeek token as before', async () => {
  const { host, contents } = browserFixture('https://chat.deepseek.com/sign_in');
  host.wire(contents);
  const event = { preventDefault: vi.fn(), isMainFrame: true };
  contents.emit('will-redirect', event, 'https://accounts.google.com/v3/signin/identifier');
  contents.emit('did-navigate', {}, 'https://accounts.google.com/v3/signin/identifier');
  expect(contents.setUserAgent).toHaveBeenLastCalledWith(firefoxAgent);
  contents.executeJavaScript.mockImplementation(async code => code.includes('userToken') ? true : undefined);
  contents.emit('did-navigate', {}, 'https://chat.deepseek.com/');
  expect(contents.setUserAgent).toHaveBeenLastCalledWith(chromiumAgent);
  await settle();
  expect(cosBrowserSignedIn()).toBe(true);
  // Returning to the provider starts a new flow if the person chooses Google again.
  contents.emit('will-navigate', event, 'https://accounts.google.com/o/oauth2/v2/auth');
  expect(contents.loadURL).toHaveBeenCalledTimes(2);
  expect(contents.setUserAgent).toHaveBeenLastCalledWith(firefoxAgent);
});

it('allows DeepSeek Google and Apple popups in the same partition and gives only Google Firefox identity', () => {
  const { host, contents } = browserFixture('https://chat.deepseek.com/sign_in');
  host.wire(contents);
  const open = contents.setWindowOpenHandler.mock.calls[0]![0];
  const googleUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  for (const url of [googleUrl, 'https://appleid.apple.com/auth/authorize']) {
    expect(open({ url })).toMatchObject({ action: 'allow', overrideBrowserWindowOptions: {
      webPreferences: { partition: 'persist:cos-browser', contextIsolation: true, nodeIntegration: false, sandbox: true }
    } });
  }
  const child = Object.assign(new EventEmitter(), { id: 42, setUserAgent: vi.fn() });
  contents.emit('did-create-window', { webContents: child }, { url: googleUrl });
  expect(child.setUserAgent).toHaveBeenCalledExactlyOnceWith(firefoxAgent);
  child.emit('did-navigate', {}, 'https://chat.deepseek.com/');
  expect(child.setUserAgent).toHaveBeenLastCalledWith(chromiumAgent);
  const apple = Object.assign(new EventEmitter(), { id: 43, setUserAgent: vi.fn() });
  contents.emit('did-create-window', { webContents: apple }, { url: 'https://appleid.apple.com/auth/authorize' });
  expect(apple.setUserAgent).not.toHaveBeenCalled();
  expect(contents.setUserAgent).not.toHaveBeenCalled();
  expect(native.dialog).not.toHaveBeenCalled();
  expect(native.panels).toHaveLength(0);
});

it('registers one Google header hook, scoped to live DeepSeek Google tabs and popups', () => {
  const { host, contents } = browserFixture('https://chat.deepseek.com/sign_in');
  const ses = configureSession(host);
  host.configure(ses);
  expect(ses.setUserAgent).toHaveBeenCalledExactlyOnceWith(chromiumAgent);
  expect(ses.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
  const [filter, beforeSend] = ses.webRequest.onBeforeSendHeaders.mock.calls[0]!;
  expect(filter).toEqual({ urls: ['https://accounts.google.com/*'] });
  const headers = { 'User-Agent': chromiumAgent, 'user-agent': chromiumAgent, 'Sec-CH-UA': 'Chromium',
    'sec-ch-ua-mobile': '?0', 'SEC-CH-UA-PLATFORM': 'Linux', 'Sec-CH-UA-Full-Version-List': 'Chromium/150',
    Accept: 'text/html', Cookie: 'synthetic' };
  const request = (webContentsId: number | undefined) => {
    const reply = vi.fn();
    beforeSend({ url: 'https://accounts.google.com/v3/signin/identifier', webContentsId, requestHeaders: { ...headers } }, reply);
    expect(reply).toHaveBeenCalledTimes(1);
    return reply.mock.calls[0]![0].requestHeaders;
  };
  expect(request(contents.id)).toEqual(headers);
  host.wire(contents);
  contents.emit('will-redirect', { preventDefault: vi.fn(), isMainFrame: true }, 'https://accounts.google.com/');
  const firefoxHeaders = { 'User-Agent': firefoxAgent, Accept: 'text/html', Cookie: 'synthetic' };
  expect(request(contents.id)).toEqual(firefoxHeaders);
  expect(request(99)).toEqual(headers);
  expect(request(undefined)).toEqual(headers);
  contents.emit('did-navigate', {}, 'https://chat.deepseek.com/');
  expect(request(contents.id)).toEqual(headers);

  // did-create-window runs synchronously; the network header hook covers the first popup request.
  const googleUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  contents.setWindowOpenHandler.mock.calls[0]![0]({ url: googleUrl });
  const child = Object.assign(new EventEmitter(), { id: 42, setUserAgent: vi.fn() });
  contents.emit('did-create-window', { webContents: child }, { url: googleUrl });
  expect(request(child.id)).toEqual(firefoxHeaders);
  child.emit('destroyed');
  expect(request(child.id)).toEqual(headers);

  contents.emit('will-redirect', { preventDefault: vi.fn(), isMainFrame: true }, googleUrl);
  expect(request(contents.id)).toEqual(firefoxHeaders);
  contents.emit('destroyed');
  expect(request(contents.id)).toEqual(headers);
  expect(ses.setUserAgent).toHaveBeenCalledExactlyOnceWith(chromiumAgent);
});

it('leaves DeepSeek iframe redirects and Google lookalikes outside Google mode', () => {
  const { host, contents } = browserFixture('https://chat.deepseek.com/sign_in');
  host.wire(contents);
  const event = { preventDefault: vi.fn(), isMainFrame: false };
  contents.emit('will-redirect', event, 'https://accounts.google.com/');
  contents.emit('will-navigate', { ...event, isMainFrame: true }, 'https://accounts.google.com.evil.test/');
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(contents.loadURL).not.toHaveBeenCalled();
  expect(contents.setUserAgent).not.toHaveBeenCalled();
  expect(native.dialog).not.toHaveBeenCalled();
});

it('reads DeepSeek\'s own token, so /sign_up is not mistaken for a session', async () => {
  const { host, contents } = browserFixture('https://chat.deepseek.com/sign_up');
  contents.executeJavaScript = vi.fn(async (code: string) => code.includes('userToken') ? false : undefined);
  host.wire(contents);
  contents.emit('did-finish-load');
  await settle();
  expect(cosBrowserSignedIn()).toBe(false);
  expect(contents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("localStorage.getItem('userToken')"));
});

it('installs the device-id fix on DeepSeek pages so login can send one', async () => {
  const { host, contents } = browserFixture('https://chat.deepseek.com/sign_in');
  host.wire(contents);
  contents.emit('did-finish-load');
  await settle();
  expect(contents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('__cosReadyFix'));
});

it('signs out by clearing only DeepSeek\'s storage and showing its login', async () => {
  const { host } = browserFixture('https://chat.deepseek.com/');
  host.startPromise = Promise.resolve();
  const clear = vi.fn(async () => {});
  host.ses.clearStorageData = clear;
  const show = vi.spyOn(host, 'showSignIn').mockResolvedValue(undefined);
  setCosBrowserSignedIn(true);
  await host.signOut();
  expect(clear).toHaveBeenCalledExactlyOnceWith({ origin: 'https://chat.deepseek.com',
    storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
  expect(cosBrowserSignedIn()).toBe(false);
  expect(show).toHaveBeenCalledTimes(1);
});

it('still hands a committed ChatGPT tab\'s Google login to the external-browser card', () => {
  const { host, contents } = browserFixture('https://chatgpt.com/');
  host.wire(contents);
  contents.emit('did-navigate', {}, 'https://chatgpt.com/');
  const event = { preventDefault: vi.fn(), isMainFrame: true };
  contents.emit('will-redirect', event, 'https://accounts.google.com/v3/signin/identifier');
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  expect(native.panels).toHaveLength(1);
  expect(contents.setWindowOpenHandler.mock.calls[0]![0]({ url: 'https://accounts.google.com/' })).toEqual({ action: 'deny' });
  expect(native.panels).toHaveLength(1);
  expect(contents.setUserAgent).not.toHaveBeenCalled();
});

it('leaves lookalikes and iframe redirects alone and revokes the offer with its tab', async () => {
  const { host, contents } = browserFixture();
  host.wire(contents);
  const event = { preventDefault: vi.fn(), isMainFrame: false };
  contents.emit('will-redirect', event, 'https://accounts.google.com/');
  contents.emit('will-navigate', { ...event, isMainFrame: true }, 'https://accounts.google.com.evil.test/');
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(native.panels).toHaveLength(0);
  host.googleSignIn(contents);
  host.signInAction(native.panels[0]!.webContents, 'choose', 'chrome');
  await settle();
  expect(cosSignInTransfer.pending()).not.toBeNull();
  contents.emit('destroyed');
  expect(cosSignInTransfer.pending()).toBeNull();
  expect(native.panels[0]!.webContents.close).toHaveBeenCalled();
  expect(host.signIn).toBeNull();
});

it('returns to the choice when the browser cannot open or the offer is revoked, and closes once imported', async () => {
  const { host, contents } = browserFixture();
  host.googleSignIn(contents);
  const panel = native.panels[0]!;
  native.open.mockRejectedValueOnce(new Error('missing'));
  host.signInAction(panel.webContents, 'choose', 'chrome');
  await settle();
  expect(panelState()).toMatchObject({ phase: 'choose', notice: 'launch_failed' });
  expect(cosSignInTransfer.pending()).toBeNull();

  host.signInAction(panel.webContents, 'choose', 'chrome');
  await settle();
  cosSignInTransfer.cancel();
  expect(panelState()).toMatchObject({ phase: 'choose', notice: 'ended' });

  host.signInAction(panel.webContents, 'choose', 'edge');
  await settle();
  host.importSignIn = vi.fn(async () => {});
  const offer = cosSignInTransfer.pending()!;
  await cosSignInTransfer.accept(offer.id, 'browser-a', [{ name: '__Secure-next-auth.session-token', value: 'synthetic',
    domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, hostOnly: false, sameSite: 'lax' }]);
  // The card confirms the sign-in, then plays its exit before its view goes.
  expect(panelState()).toMatchObject({ phase: 'done' });
  expect(cosSignInTransfer.pending()).toBeNull();
  await new Promise(resolve => setTimeout(resolve, 1200));
  expect(host.signIn).toBeNull();
  expect(panel.webContents.send).toHaveBeenCalledWith('cos-browser-sign-in:leave');
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(panel.webContents.close).toHaveBeenCalled();
  // The receipt survives the panel: a retried POST of the same transfer still succeeds.
  await expect(cosSignInTransfer.accept(offer.id, 'browser-a', [])).resolves.toBeUndefined();
});

it('puts DeepSeek login back under the card, and cancelling leaves it there', async () => {
  const { host, contents } = browserFixture('');
  host.googleSignIn(contents);
  expect(contents.loadURL).toHaveBeenCalledExactlyOnceWith('https://chat.deepseek.com/sign_in');
  host.signInAction(native.panels[0]!.webContents, 'choose', 'edge');
  await settle();
  host.signInAction(native.panels[0]!.webContents, 'cancel');
  expect(cosSignInTransfer.pending()).toBeNull();
  expect(host.signIn).toBeNull();
  expect(contents.loadURL).toHaveBeenCalledTimes(1);
});

const cookie = (index: number, value: string) => ({ name: `__Secure-next-auth.session-token.${index}`, value,
  domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, hostOnly: false, sameSite: 'lax' });

function cookieFixture() {
  const { host, contents } = browserFixture();
  const old = [cookie(0, 'synthetic-old-0'), cookie(1, 'synthetic-old-1')];
  const jar = new Map(old.map(cookie => [cookie.name, cookie]));
  const api = {
    get: vi.fn(async () => [...jar.values()]),
    remove: vi.fn(async (_url: string, name: string) => { jar.delete(name); }),
    set: vi.fn(async (input: any) => { jar.set(input.name, input); void host.readSignIn(host.ses); }),
    flushStore: vi.fn(async () => {})
  };
  host.ses.cookies = api;
  return { host, contents, api, jar, old };
}

it('never writes another browser\'s ChatGPT cookies into the DeepSeek browser', async () => {
  const { host, contents, api, jar } = cookieFixture();
  setCosBrowserSignedIn(false);
  const observed: Array<boolean | null> = [];
  const off = onCosBrowserSignInChange(() => observed.push(cosBrowserSignedIn()));
  try {
    await host.importSignIn(host.ses, contents, [cookie(0, 'synthetic-new-0')], () => true);
    // The DeepSeek browser signs in on its own page; a ChatGPT session token is not evidence
    // and must never be written to this origin or published as a sign-in.
    expect(api.set).not.toHaveBeenCalled();
    expect([...jar.values()].map(cookie => cookie.value)).toEqual(['synthetic-old-0', 'synthetic-old-1']);
    expect(observed).toEqual([]);
    expect(contents.loadURL).toHaveBeenCalledWith('https://chat.deepseek.com/');
  } finally { off(); }
});

it('leaves the cookie jar alone even while a chat is running', async () => {
  const { host, contents, api } = cookieFixture();
  host.generating = new Set(['synthetic-running-chat']);
  // There is no transfer to guard: the import is refused before it can touch the jar, so a
  // busy browser is not turned into an error the caller has to interpret.
  await expect(host.importSignIn(host.ses, contents, [cookie(0, 'synthetic-new-0')], () => true)).resolves.toBeUndefined();
  expect(api.get).not.toHaveBeenCalled();
  expect(api.set).not.toHaveBeenCalled();
  expect(contents.loadURL).toHaveBeenCalledWith('https://chat.deepseek.com/');
});

it('sends a signed-out sign-in click to DeepSeek login in the open DeepSeek tab, and only shows a signed-in browser', async () => {
  const { host, contents } = browserFixture('https://chat.deepseek.com/');
  host.startPromise = Promise.resolve();
  const navigate = vi.spyOn(host.control, 'navigate').mockImplementation(() => {});
  const show = vi.spyOn(host, 'show').mockResolvedValue(undefined);
  setCosBrowserSignedIn(false);
  await host.showSignIn();
  expect(navigate).toHaveBeenCalledExactlyOnceWith(contents.id, 'https://chat.deepseek.com/sign_in');
  setCosBrowserSignedIn(true);
  await host.showSignIn();
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(show).toHaveBeenCalledTimes(1);
});

it('tells its owner when the user puts a shown window away, never when the app hides it', () => {
  const onUserHide = vi.fn();
  const host = new CosBrowser({ preloadDir: 'unused', rendererUrl: () => null, rendererDir: 'unused', onUserHide }) as any;
  const windowId = host.model.createWindow({ type: 'normal', state: 'normal' });
  let visible = true;
  const base = { hide: vi.fn(() => { visible = false; }), isVisible: () => visible, isFocused: () => false };
  host.frames.set(windowId, { id: windowId, base, shown: true });
  // The extension or the app minimizing it is not the user closing it: no notice.
  host.hideWindow(windowId);
  expect(onUserHide).not.toHaveBeenCalled();
  // Closing a window already put away says nothing either.
  host.userHide(windowId);
  expect(onUserHide).not.toHaveBeenCalled();
  visible = true;
  host.frames.get(windowId).shown = true;
  host.userHide(windowId);
  expect(base.hide).toHaveBeenCalledTimes(2);
  expect(onUserHide).toHaveBeenCalledTimes(1);
});

it('keeps a window the user minimizes in the taskbar, and reports it minimized until restored (#1464)', () => {
  const onUserHide = vi.fn();
  const host = new CosBrowser({ preloadDir: 'unused', rendererUrl: () => null, rendererDir: 'unused', onUserHide }) as any;
  const windowId = host.model.createWindow({ type: 'normal', state: 'normal' });
  let maximized = false;
  const base = { hide: vi.fn(), isVisible: () => true, isFocused: () => false, isMaximized: () => maximized,
    isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) };
  host.frames.set(windowId, { id: windowId, base, toolbar: { setBounds: vi.fn() }, shown: true });
  host.userMinimize(windowId);
  // A minimized window stays where the user can restore it: not hidden, no "brought back from the tray" notice.
  expect(base.hide).not.toHaveBeenCalled();
  expect(onUserHide).not.toHaveBeenCalled();
  expect(host.frames.get(windowId).shown).toBe(true);
  expect(host.model.window(windowId)?.state).toBe('minimized');
  host.userRestore(windowId);
  expect(host.model.window(windowId)?.state).toBe('normal');
  maximized = true;
  host.userMinimize(windowId);
  host.userRestore(windowId);
  expect(host.model.window(windowId)?.state).toBe('maximized');
});

// The maintainer's idea (2026-10-14): let people choose where a minimized built-in browser goes.
it('hides a window the user minimizes to the tray when that is the chosen place, and keeps it in the taskbar otherwise', () => {
  let place: 'taskbar' | 'tray' = 'tray';
  const onUserHide = vi.fn();
  const host = new CosBrowser({ preloadDir: 'unused', rendererUrl: () => null, rendererDir: 'unused', onUserHide,
    minimizeTo: () => place }) as any;
  const windowId = host.model.createWindow({ type: 'normal', state: 'normal' });
  const base = { hide: vi.fn(), isVisible: () => true, isFocused: () => false, isMaximized: () => false,
    isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) };
  host.frames.set(windowId, { id: windowId, base, toolbar: { setBounds: vi.fn() }, shown: true });
  host.userMinimize(windowId);
  expect(base.hide).toHaveBeenCalledTimes(1);
  expect(onUserHide).toHaveBeenCalledTimes(1);
  expect(host.frames.get(windowId).shown).toBe(false);
  expect(host.model.window(windowId)?.state).toBe('minimized');

  place = 'taskbar';
  host.frames.get(windowId).shown = true;
  host.userMinimize(windowId);
  expect(base.hide).toHaveBeenCalledTimes(1);
  expect(host.frames.get(windowId).shown).toBe(true);
});

it('loads DeepSeek web pages and the empty page, refusing legacy ChatGPT and non-web URLs', () => {
  const { host, contents } = browserFixture('https://chat.deepseek.com/');
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'chrome://settings', 'not a url',
    'https://chatgpt.com/c/abc']) host.control.navigate(contents.id, url);
  expect(contents.loadURL).not.toHaveBeenCalled();
  host.control.navigate(contents.id, 'https://chat.deepseek.com/a/chat/s/abc');
  host.control.navigate(contents.id, 'about:blank');
  expect((contents.loadURL.mock.calls as unknown as string[][]).map(call => call[0])).toEqual(['https://chat.deepseek.com/a/chat/s/abc', 'about:blank']);
});
