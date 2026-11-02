import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const locales = ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
});
afterEach(() => {
  for (const locale of locales) vi.doUnmock(`../src/renderer/locales/${locale}.json`);
  vi.unstubAllGlobals();
  dom.window.close();
});

it('imports no catalog for English and only the chosen catalog for a translated language', async () => {
  const loaded: string[] = [];
  for (const locale of locales) {
    vi.doMock(`../src/renderer/locales/${locale}.json`, async () => {
      loaded.push(locale);
      return vi.importActual(`../src/renderer/locales/${locale}.json`);
    });
  }
  const { initLanguage, setLanguage, t } = await import('../src/renderer/i18n.js');
  expect(loaded).toEqual([]);
  await initLanguage();
  expect(loaded).toEqual([]);
  expect(t('Settings')).toBe('Settings');
  await setLanguage('de');
  expect(loaded).toEqual(['de']);
  expect(t('Settings')).toBe('Einstellungen');
  expect(document.querySelector('.setup-heading h1')!.textContent).toBe('Einrichtung');
  await setLanguage('en');
  expect(loaded).toEqual(['de']);
  expect(t('Settings')).toBe('Settings');
  expect(document.querySelector('.setup-heading h1')!.textContent).toBe('Setup');
});

it('waits for the saved catalog before revealing the shell or resolving initialization', async () => {
  window.localStorage.setItem('cos.ui.language', 'de');
  const gate = deferred();
  const entered = deferred();
  vi.doMock('../src/renderer/locales/de.json', async () => {
    entered.resolve();
    await gate.promise;
    return vi.importActual('../src/renderer/locales/de.json');
  });
  const { initLanguage, t } = await import('../src/renderer/i18n.js');
  let ready = false;
  const initialization = initLanguage().then(() => { ready = true; });
  await entered.promise;
  expect(ready).toBe(false);
  expect(document.body.hidden).toBe(true);
  gate.resolve();
  await initialization;
  expect(document.body.hidden).toBe(false);
  expect(t('Settings')).toBe('Einstellungen');
  expect(document.querySelector('.setup-heading h1')!.textContent).toBe('Einrichtung');
});

it('keeps the current labels while loading and refuses a stale language switch', async () => {
  const gate = deferred();
  const entered = deferred();
  vi.doMock('../src/renderer/locales/de.json', async () => {
    entered.resolve();
    await gate.promise;
    return vi.importActual('../src/renderer/locales/de.json');
  });
  const { initLanguage, setLanguage, currentLanguage, onLanguageChange, t } = await import('../src/renderer/i18n.js');
  await initLanguage();
  const changed = vi.fn();
  onLanguageChange(changed);
  const pending = setLanguage('de');
  await entered.promise;
  expect(currentLanguage()).toBe('en');
  expect(document.documentElement.lang).toBe('en');
  expect(t('Settings')).toBe('Settings');
  expect(changed).not.toHaveBeenCalled();
  await setLanguage('ja');
  gate.resolve();
  await pending;
  expect(currentLanguage()).toBe('ja');
  expect(document.documentElement.lang).toBe('ja');
  expect(window.localStorage.getItem('cos.ui.language')).toBe('ja');
  expect(t('Settings')).toBe('設定');
  expect(changed).toHaveBeenCalledTimes(1);
});

it('retains the working language and labels when a catalog fails to load', async () => {
  vi.doMock('../src/renderer/locales/de.json', () => { throw new Error('catalog unavailable'); });
  const { initLanguage, setLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
  await initLanguage();
  await setLanguage('ja');
  await expect(setLanguage('de')).rejects.toThrow();
  expect(currentLanguage()).toBe('ja');
  expect(document.documentElement.lang).toBe('ja');
  expect(window.localStorage.getItem('cos.ui.language')).toBe('ja');
  expect(t('Settings')).toBe('設定');
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  select.value = 'de';
  select.dispatchEvent(new dom.window.Event('change'));
  await vi.waitFor(() => expect(select.value).toBe('ja'));
  expect(error).toHaveBeenCalledOnce();
  error.mockRestore();
});

it('awaits the sign-in card catalog before painting and discards a state superseded while loading', async () => {
  const page = new JSDOM(readFileSync('src/renderer/cos-browser-sign-in.html', 'utf8'));
  document.body.innerHTML = page.window.document.body.innerHTML;
  document.body.hidden = false;
  page.window.close();
  const gate = deferred();
  const entered = deferred();
  vi.doMock('../src/renderer/locales/de.json', async () => {
    entered.resolve();
    await gate.promise;
    return vi.importActual('../src/renderer/locales/de.json');
  });
  let paint!: (state: unknown) => Promise<void>;
  let leave!: () => void;
  Object.assign(window, { cosSignIn: {
    act: vi.fn(), onState: (listener: typeof paint) => { paint = listener; },
    onLeave: (listener: typeof leave) => { leave = listener; }
  } });
  await import('../src/renderer/cos-browser-sign-in.js');
  const state = { phase: 'choose', browsers: [], browser: null, launching: false, notice: null, appIcon: null, tokens: {} };
  const pending = paint({ ...state, language: 'de' });
  await entered.promise;
  expect(document.getElementById('card')!.hidden).toBe(true);
  await paint({ ...state, language: 'ja' });
  const { currentLanguage, t } = await import('../src/renderer/i18n.js');
  expect(document.getElementById('card')!.hidden).toBe(false);
  expect(document.getElementById('title')!.textContent).toBe(t('Sign in with Google'));
  expect(currentLanguage()).toBe('ja');
  leave();
  gate.resolve();
  await pending;
  expect(document.body.classList.contains('leaving')).toBe(true);
  expect(currentLanguage()).toBe('ja');
  expect(document.getElementById('title')!.textContent).toBe(t('Sign in with Google'));
});

it('reveals the shell in English when the saved catalog cannot load', async () => {
  window.localStorage.setItem('cos.ui.language', 'de');
  vi.doMock('../src/renderer/locales/de.json', async () => { throw new Error('chunk missing'); });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { initLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
  await initLanguage();
  expect(document.body.hidden).toBe(false);
  expect(currentLanguage()).toBe('en');
  expect(t('Settings')).toBe('Settings');
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});
