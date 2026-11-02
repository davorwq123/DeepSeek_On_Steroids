import { expect, it } from 'vitest';
import { updateReadiness } from '../src/renderer/update-readiness-state.js';
import { DEFAULT_USAGE_FORMULA, usageEstimate, usageModel } from '../src/shared/usage.js';
import { goalErrorMessage } from '../src/shared/goal-errors.js';

it('accepts a signed-in DeepSeek browser without a tunnel, extension or connector', () => {
  const state = { cosBrowserSignedIn: true,
    update: { current: '2.1.47', stage: 'idle', latest: null, error: null, checkedAt: null, unavailable: true },
    bridge: {}, status: { state: 'disconnected', surfaces: [] }, config: {} } as any;
  const rows = updateReadiness(state);
  expect(rows.every(row => row.status === 'pass' || row.status === 'skipped')).toBe(true);
  expect(rows.map(row => row.id)).toEqual(['app', 'browser']);
  state.cosBrowserSignedIn = null;
  expect(updateReadiness(state).find(row => row.id === 'browser')!.status).toBe('not-run');
  state.cosBrowserSignedIn = false;
  expect(updateReadiness(state).find(row => row.id === 'browser')!.detail).toBe('Sign in to DeepSeek');
});

it('compares a retired DeepSeek web alias at the current Flash rate and preserves explicit overrides', () => {
  expect(usageModel('deepseek-v4-pro')).toBe('deepseek-flash');
  const rows = [{ model: 'deepseek-v4-pro', reasoningEffort: 'high', assumed: false, tokens: 97_700 }];
  expect(usageEstimate(rows, DEFAULT_USAGE_FORMULA).cost).toBeCloseTo(0.00070344, 10);
  expect(usageEstimate(rows, { ...DEFAULT_USAGE_FORMULA, rates: { 'deepseek-v4-pro': 0 } }).cost).toBe(0);
});

it('explains a missing helper composer and signed-out browser without suggesting a tunnel', () => {
  expect(goalErrorMessage('request_failed: deepseek_signed_out')).toContain('Sign in to DeepSeek');
  expect(goalErrorMessage('request_failed: helper_send_failed: no-composer')).toContain('composer');
  expect(goalErrorMessage('request_failed: helper_page_not_ready')).toContain('ready');
  expect(goalErrorMessage('request_failed: helper_chat_not_started')).toContain('confirm');
});
