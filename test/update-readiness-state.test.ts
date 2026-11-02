import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { updateReadiness } from '../src/renderer/update-readiness-state.js';
import { setLanguage } from '../src/renderer/i18n.js';
const state = () => ({ cosBrowserSignedIn: true,
  update: { current: '2.1.47', latest: null, stage: 'idle', checkedAt: 1, error: null },
  status: { state: 'auth-failed', detail: 'Legacy tunnel error', surfaces: [] },
  bridge: { present: false }, connectorRefresh: { core: { state: 'failed' } }
} as any);
let dom: JSDOM;
beforeEach(async () => {
  dom = new JSDOM('<html><body></body></html>', { url: 'https://local.test/' });
  vi.stubGlobal('document', dom.window.document); vi.stubGlobal('window', dom.window);
  await setLanguage('en');
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
it('requires current app-update and browser evidence, independently of legacy connector state', () => {
  expect(updateReadiness(state()).map(row => row.status)).toEqual(['pass', 'pass']);
  const next = state(); next.update.checkedAt = null;
  expect(updateReadiness(next)[0]!.status).toBe('not-run');
  next.update.unavailable = true;
  expect(updateReadiness(next)[0]).toMatchObject({ status: 'skipped', nextStep: undefined });
  expect(updateReadiness(next)[1]!.status).toBe('pass');
});
it.each([null, undefined, false])('never treats unknown or signed-out browser state (%s) as ready', signedIn => {
  const next = state(); next.cosBrowserSignedIn = signedIn;
  const row = updateReadiness(next)[1]!;
  expect(row.status).toBe('not-run'); expect(row.nextStep).toBe('Review setup');
  expect(row.detail).toBe(signedIn === false ? 'Sign in to DeepSeek' : 'Checking…');
  expect(JSON.stringify(row)).not.toContain('tunnel');
});
it('shows app-update failures even while the browser is signed in', () => {
  const next = state(); next.update.stage = 'failed'; next.update.error = 'Network unavailable';
  expect(updateReadiness(next)[0]).toMatchObject({ status: 'fail', reason: 'Network unavailable' });
  expect(updateReadiness(next)[1]!.status).toBe('pass');
});
it('names manual macOS replacement only for a confirmed update', () => {
  const next = state(); next.platform = { family: 'macos' }; next.update.latest = '99.0.0';
  expect(updateReadiness(next)[0]!.nextStep).toContain('/Applications');
  next.update.stage = 'failed'; expect(updateReadiness(next)[0]!.nextStep).not.toContain('/Applications');
});
it('translates browser status without requiring extension versions or plugin schemas', async () => {
  await setLanguage('ja');
  expect(updateReadiness(state())[1]!.detail).not.toBe('Signed in to DeepSeek');
});
