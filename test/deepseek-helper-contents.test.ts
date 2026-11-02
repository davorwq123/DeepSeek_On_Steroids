import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/** The page driver never adopts the hidden window of a helper chat, only the person's own pages. */

vi.mock('../src/main/session/recorder.js', () => ({ recordChatObservations: vi.fn(async () => ({ sessionId: 's' })), recordNote: vi.fn() }));
vi.mock('../src/main/session/store.js', () => ({ findSessionByConversation: vi.fn(async () => null) }));
vi.mock('../src/main/session/input.js', () => ({
  pendingBrowserInputs: vi.fn(async () => []), claimBrowserInput: vi.fn(), acknowledgeBrowserInput: vi.fn(), failBrowserInput: vi.fn()
}));
vi.mock('../src/main/deepseek/reply.js', () => ({ deliverDeepSeekReply: vi.fn() }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

import { attachDeepSeekPageDriver } from '../src/main/deepseek/page-driver.js';
import { markDeepSeekHelperContents } from '../src/main/deepseek/helper-contents.js';

function contents(id: number) {
  const executeJavaScript = vi.fn(async () => null);
  const page = Object.assign(new EventEmitter(), {
    id, isDestroyed: () => false, getURL: () => 'https://chat.deepseek.com/', executeJavaScript
  });
  return { page, executeJavaScript };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('drives an ordinary DeepSeek page but leaves a helper window alone', async () => {
  const ordinary = contents(1);
  const helper = contents(2);
  markDeepSeekHelperContents(helper.page as any);
  attachDeepSeekPageDriver(ordinary.page as any);
  attachDeepSeekPageDriver(helper.page as any);
  helper.page.emit('did-finish-load');
  helper.page.emit('did-navigate-in-page');
  await vi.advanceTimersByTimeAsync(3_000);

  expect(ordinary.executeJavaScript).toHaveBeenCalled();
  expect(helper.executeJavaScript).not.toHaveBeenCalled();
  ordinary.page.emit('destroyed');
  helper.page.emit('destroyed');
});
