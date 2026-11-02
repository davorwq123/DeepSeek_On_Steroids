import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules(); dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
const state = () => ({ cosBrowserSignedIn: true,
  update: { current: '2.1.47', latest: null, stage: 'idle', checkedAt: 1, error: null } } as any);
it('shows only app and browser owners, hides unavailable updates, and accepts a tunnel-free signed-in browser', async () => {
  const { paintUpdateReadiness } = await import('../src/renderer/update-readiness.js');
  const next = state(); next.update.unavailable = true; paintUpdateReadiness(next);
  expect(document.getElementById('updateReadinessSummary')!.textContent).toBe('All checks passed');
  expect([...document.querySelectorAll('[data-update-part]')].map(row => (row as HTMLElement).dataset.updatePart)).toEqual(['app', 'browser']);
  expect(document.getElementById('updateAll')!.hidden).toBe(true);
});
it('preserves disclosure and keyboard focus through repeated state pushes', async () => {
  const { initUpdateReadiness, paintUpdateReadiness } = await import('../src/renderer/update-readiness.js');
  initUpdateReadiness(); const next = state(); paintUpdateReadiness(next);
  const details = document.getElementById('updateReadinessDetails') as HTMLDetailsElement;
  expect(details.open).toBe(false);
  document.getElementById('updateReadinessSummary')!.click(); expect(details.open).toBe(true);
  paintUpdateReadiness(structuredClone(next)); expect(details.open).toBe(true);
  next.cosBrowserSignedIn = false; paintUpdateReadiness(next);
  document.getElementById('updateReviewSetup')!.focus();
  next.cosBrowserSignedIn = true; paintUpdateReadiness(next);
  expect(details.open).toBe(true); expect(document.activeElement!.id).toBe('updateReviewSetup');
});
it('announces changes independently of the disclosure and translates without moving focus', async () => {
  const { initUpdateReadiness, paintUpdateReadiness } = await import('../src/renderer/update-readiness.js');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  initUpdateReadiness(); const next = state();
  const toggle = document.getElementById('updateReadinessToggle')!; toggle.focus(); paintUpdateReadiness(next);
  const live = document.getElementById('updateReadinessAnnounce')!;
  expect(live.closest('button, details')).toBeNull(); expect(live.textContent).toBe('All checks passed');
  next.cosBrowserSignedIn = null; paintUpdateReadiness(next); expect(live.textContent).toBe('Checks incomplete');
  await setLanguage('ja'); expect(live.textContent).toBe('確認が完了していません'); expect(document.activeElement).toBe(toggle);
});
it('reopens for changed browser evidence or operation failures, but respects a manual collapse', async () => {
  const { initUpdateReadiness, paintUpdateReadiness } = await import('../src/renderer/update-readiness.js');
  initUpdateReadiness(); const next = state(); paintUpdateReadiness(next);
  const details = document.getElementById('updateReadinessDetails') as HTMLDetailsElement;
  paintUpdateReadiness(next, 'Network unavailable'); expect(details.open).toBe(true); details.open = false;
  paintUpdateReadiness(structuredClone(next), 'Network unavailable'); expect(details.open).toBe(false);
  paintUpdateReadiness(next); expect(document.getElementById('updateAllError')!.hidden).toBe(true);
  next.cosBrowserSignedIn = false; paintUpdateReadiness(next); expect(details.open).toBe(true);
});
