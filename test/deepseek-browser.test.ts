import { beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({ ensureBackground: vi.fn(), showSignIn: vi.fn(), signedIn: null as boolean | null }));

vi.mock('../src/main/cos-browser/selection.js', () => ({
  loadCosBrowser: async () => browser
}));
vi.mock('../src/main/cos-browser/sign-in.js', () => ({ cosBrowserSignedIn: () => browser.signedIn }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { backgroundChats: true } }) }));

import { deepSeekOpeningUrl, ensureDeepSeekPage } from '../src/main/deepseek/browser.js';
import { deepSeekConversationUrl } from '../src/main/deepseek/site.js';

const conversationId = 'a97f3e4c-de96-4fc4-ada0-123456789abc';

describe('opening the DeepSeek page for one outbox row', () => {
  beforeEach(() => {
    browser.ensureBackground.mockReset().mockResolvedValue(undefined);
    browser.showSignIn.mockReset().mockResolvedValue(undefined);
    browser.signedIn = null;
  });

  it('opens sign-in and reports that the same message will send automatically', async () => {
    browser.signedIn = false;
    await expect(ensureDeepSeekPage({ inputId: 'input-7' })).rejects.toThrow(
      'Message queued. Waiting for DeepSeek sign-in: Sign in to DeepSeek in the app’s browser. This message sends automatically once you do.');
    expect(browser.showSignIn).toHaveBeenCalledOnce();
    expect(browser.ensureBackground).not.toHaveBeenCalled();
  });

  it('reuses or opens the tab showing an existing conversation', async () => {
    await ensureDeepSeekPage({ conversationId });
    expect(browser.ensureBackground).toHaveBeenCalledWith(deepSeekConversationUrl(conversationId), { conversationId }, false);
  });

  it('opens a new chat marked for exactly that input', async () => {
    await ensureDeepSeekPage({ inputId: 'input-7' });
    const url = deepSeekOpeningUrl('input-7');
    expect(url).toBe('https://chat.deepseek.com/?cos-input=input-7#cos-input=input-7');
    expect(browser.ensureBackground).toHaveBeenCalledWith(url, { marker: 'cos-input=input-7' }, false);
  });

  it('does nothing without a target', async () => {
    await ensureDeepSeekPage({});
    expect(browser.ensureBackground).not.toHaveBeenCalled();
  });
});
