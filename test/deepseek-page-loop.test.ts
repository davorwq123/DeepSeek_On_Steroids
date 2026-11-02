import { JSDOM } from 'jsdom';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The page loop, end to end, against a DeepSeek conversation document.
 *
 * A live signed-in account is not available to the test suite, so the page is a real DOM with
 * the structure DeepSeek renders (verified against a conversation page), and the driver runs its
 * actual injected scripts against it through a fake `WebContents`. Everything app-side is the
 * real contract: observations, the input outbox and the reply handoff.
 */

const conversationId = 'a97f3e4c-de96-4fc4-ada0-123456789abc';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  authorize: vi.fn(),
  claim: vi.fn(),
  acknowledge: vi.fn(),
  fail: vi.fn(),
  holdSignIn: vi.fn(),
  pending: vi.fn(),
  reply: vi.fn(),
  warn: vi.fn()
}));

vi.mock('../src/main/session/recorder.js', () => ({ recordChatObservations: mocks.record }));
vi.mock('../src/main/session/store.js', () => ({ findSessionByConversation: vi.fn(async () => ({ id: 'session-1' })) }));
vi.mock('../src/main/session/input.js', () => ({
  pendingBrowserInputs: mocks.pending,
  claimBrowserInput: mocks.claim,
  acknowledgeBrowserInput: mocks.acknowledge,
  failBrowserInput: mocks.fail,
  holdInputForSignIn: mocks.holdSignIn,
  authorizeBrowserInput: mocks.authorize,
  SEND_WITHDRAWN: 'Native Send was withdrawn before its click.'
}));
vi.mock('../src/main/deepseek/reply.js', () => ({ deliverDeepSeekReply: mocks.reply }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: mocks.warn }));

import { DeepSeekPageDriver, setDeepSeekWorkerBridge } from '../src/main/deepseek/page-driver.js';
import { DEEPSEEK_SNAPSHOT_SCRIPT, deepSeekMessageId } from '../src/main/deepseek/page.js';
import { prependUserPrompt } from '../src/shared/user-prompt.js';
import { cosBrowserSignedIn, setCosBrowserSignedIn } from '../src/main/cos-browser/sign-in.js';
import { parseDeepSeekReply } from '../src/main/deepseek/tool-protocol.js';

const question = '<div class="ds-message d29f3d7d _63c77b1" data-virtual-list-item-key="1"><div class="fbb737a4"><div class="ds-collapsible-text">run the tests</div></div></div>';

function answer(text: string, thinking = 'weighing the options'): string {
  return `<div class="ds-message _63c77b1" data-virtual-list-item-key="2"><div class="_74c0879"><div class="e1675d8b ds-think-content"><div class="ds-markdown">${thinking}</div></div></div><div class="ds-markdown ds-assistant-message-main-content">${text}</div></div>`;
}

function page(messages: string, extra = ''): JSDOM {
  return signedInDocument(`<!doctype html><body>
    <div class="ds-virtual-list">${messages}</div>
    <textarea></textarea>
    <button aria-label="Send">Send</button>
    ${extra}
  </body>`, `https://chat.deepseek.com/a/chat/s/${conversationId}`);
}

function signedInDocument(html: string, url: string): JSDOM {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  dom.window.localStorage.setItem('userToken', JSON.stringify({ value: 'synthetic-page-token' }));
  return dom;
}

function history(text: string, message: Record<string, unknown> = {}) {
  return { code: 0, data: { biz_code: 0, biz_data: {
    chat_session: { id: conversationId, current_message_id: 2 },
    chat_messages: [{ message_id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED',
      has_pending_fragment: false, fragments: [{ type: 'RESPONSE', content: text }], ...message }]
  } } };
}

function contents(dom: JSDOM, sent: string[]): any {
  const textarea = dom.window.document.querySelector('textarea')!;
  textarea.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key !== 'Enter') return;
    sent.push(textarea.value);
    textarea.value = '';
  });
  return silentContents(dom);
}

function silentContents(dom: JSDOM): any {
  return Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    getURL: () => dom.window.location.href,
    executeJavaScript: async (script: string) => dom.window.eval(script)
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('DeepSeek page loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.record.mockReset().mockResolvedValue({ sessionId: 'session-1', stored: 1, activity: { meaningful: true, working: true, terminal: false }, goalCandidates: [] });
    mocks.authorize.mockReset().mockResolvedValue(true);
    mocks.claim.mockReset();
    mocks.acknowledge.mockReset().mockResolvedValue(true);
    mocks.fail.mockReset().mockResolvedValue(true);
    mocks.holdSignIn.mockReset().mockResolvedValue(true);
    mocks.pending.mockReset().mockResolvedValue([]);
    mocks.reply.mockReset().mockResolvedValue({ status: 200, body: { ok: true, status: 'answer' } });
    mocks.warn.mockReset();
    setCosBrowserSignedIn(null);
  });
  afterEach(() => { vi.useRealTimers(); setDeepSeekWorkerBridge(null); setCosBrowserSignedIn(null); });

  it.each([false, true])('never sends into a document changed while its continuation claim was waiting (return to A=%s)', async returnToA => {
    const dom = page(question);
    const sent: string[] = [];
    const fake = contents(dom, sent);
    const driver = new DeepSeekPageDriver(fake);
    let release!: (entry: unknown) => void;
    mocks.pending.mockResolvedValueOnce([{ id: 'continuation-1', conversationId }]).mockResolvedValue([]);
    mocks.claim.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    driver.start();
    try {
      await vi.advanceTimersByTimeAsync(800);
      expect(mocks.claim).toHaveBeenCalledOnce();
      fake.emit('did-start-navigation', { isMainFrame: true });
      dom.window.history.pushState({}, '', '/a/chat/s/another-conversation');
      if (returnToA) {
        fake.emit('did-start-navigation', { isMainFrame: true });
        dom.window.history.pushState({}, '', `/a/chat/s/${conversationId}`);
      }
      release({ id: 'continuation-1', text: '{"type":"tool_results","results":[]}',
        deepSeekContinuation: { turnId: 'turn-1', messageId: 'reply-1' } });
      await vi.advanceTimersByTimeAsync(800);
      expect(sent).toEqual([]);
      expect(mocks.authorize).not.toHaveBeenCalled();
      expect(mocks.fail).toHaveBeenCalledWith('continuation-1', 'deepseek-page:7',
        'Native Send was withdrawn before its click.', 'navigation');
    } finally { driver.stop(); dom.window.close(); }
  });

  it.each([false, true])('reports a navigation withdrawal only while Enter has never been attempted (after Enter=%s)', async afterEnter => {
    const dom = page(question, '<button aria-pressed="false">DeepThink</button><button class="ds-button--primary">Send</button>');
    const fake = silentContents(dom);
    const driver = new DeepSeekPageDriver(fake);
    const navigation = new dom.window.EventTarget();
    Object.defineProperty(dom.window, 'navigation', { value: navigation });
    const enter = vi.fn();
    const click = vi.fn();
    const move = () => setTimeout(() => {
      navigation.dispatchEvent(new dom.window.Event('navigate'));
      fake.emit('did-start-navigation', { isMainFrame: true });
      dom.window.history.pushState({}, '', '/a/chat/s/other');
    }, 10);
    dom.window.document.querySelector('textarea')!.addEventListener('keydown', () => { enter(); if (afterEnter) move(); });
    dom.window.document.querySelector('[aria-pressed]')!.addEventListener('click', () => { if (!afterEnter) move(); });
    dom.window.document.querySelector('.ds-button--primary')!.addEventListener('click', click);
    mocks.pending.mockResolvedValueOnce([{ id: 'continuation-1', conversationId }]).mockResolvedValue([]);
    mocks.claim.mockResolvedValue({ id: 'continuation-1', text: 'exact results', model: 'deepseek-flash',
      reasoningEffort: afterEnter ? 'none' : 'high', deepSeekContinuation: { turnId: 'turn-1', messageId: 'reply-1' } });
    driver.start();
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(enter).toHaveBeenCalledTimes(afterEnter ? 1 : 0);
      expect(click).not.toHaveBeenCalled();
      expect(mocks.fail).toHaveBeenCalledExactlyOnceWith('continuation-1', 'deepseek-page:7',
        afterEnter ? 'DeepSeek did not accept the message' : 'Native Send was withdrawn before its click.', 'navigation');
    } finally { driver.stop(); dom.window.close(); }
  });

  it('acknowledges a framed internal continuation by its exact row without waiting for the receipt timeout', async () => {
    const dom = page(question);
    const framed = prependUserPrompt('', 'Tool results: exact output. Continue the task.');
    mocks.pending.mockResolvedValueOnce([{ id: 'internal-1', conversationId }]).mockResolvedValue([]);
    mocks.claim.mockResolvedValue({ id: 'internal-1', text: framed });
    const box = dom.window.document.querySelector('textarea')!;
    box.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      const row = dom.window.document.createElement('div');
      row.className = 'ds-message';
      row.innerHTML = '<div class="ds-collapsible-text"></div>';
      row.firstElementChild!.textContent = box.value;
      dom.window.document.querySelector('.ds-virtual-list')!.append(row);
      box.value = '';
    });
    const driver = new DeepSeekPageDriver(silentContents(dom));
    driver.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.acknowledge).toHaveBeenCalledWith('internal-1', 'deepseek-page:7', conversationId,
      deepSeekMessageId(conversationId, 'user', framed.trim()));
    driver.stop(); dom.window.close();
  });

  it('types a queued app message into the page and acknowledges it', async () => {
    const sent: string[] = [];
    const dom = page(question);
    const driver = new DeepSeekPageDriver(contents(dom, sent));
    mocks.pending.mockResolvedValueOnce([{ id: 'input-1', conversationId, lifetime: undefined }]).mockResolvedValue([]);
    mocks.claim.mockResolvedValue({ id: 'input-1', text: 'please summarise the failures' });

    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(sent).toEqual(['please summarise the failures']);
    // The page has not drawn the question yet: the receipt is still pending.
    expect(mocks.acknowledge).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(6_200);
    await settle();

    expect(sent).toEqual(['please summarise the failures']);
    expect(mocks.acknowledge).toHaveBeenCalledWith('input-1', 'deepseek-page:7', conversationId, undefined);
    expect(mocks.fail).not.toHaveBeenCalled();
    driver.stop();
  });

  it.each([false, true])('keeps an unmarked page from taking the sole new-chat message before its own page opens (composer=%s)', async composer => {
    const unmarked = signedInDocument(composer ? '<textarea>personal draft</textarea>' : '<p>Loading</p>', 'https://chat.deepseek.com/');
    const marked = signedInDocument('<textarea></textarea>', 'https://chat.deepseek.com/?cos-input=opening-race');
    const wrong: string[] = [], sent: string[] = [];
    const strayContents = Object.assign(composer ? contents(unmarked, wrong) : silentContents(unmarked), { id: 51 });
    const stray = new DeepSeekPageDriver(strayContents);
    const elected = new DeepSeekPageDriver(contents(marked, sent));
    let owner: string | null = null;
    mocks.pending.mockResolvedValue([{ id: 'opening-race', conversationId: null }]);
    mocks.claim.mockImplementation(async (_id, page) => {
      if (owner && owner !== page) return null;
      owner = page;
      return { id: 'opening-race', sessionId: 'opening-session', text: 'hello' };
    });
    stray.start();
    try {
      await vi.advanceTimersByTimeAsync(800);
      elected.start();
      await vi.advanceTimersByTimeAsync(800);
      expect(wrong).toEqual([]);
      expect(sent).toEqual(['hello']);
      expect(mocks.claim.mock.calls.map(call => call[1])).toEqual(['deepseek-page:7']);
      if (composer) expect(unmarked.window.document.querySelector('textarea')!.value).toBe('personal draft');
    } finally { stray.stop(); elected.stop(); unmarked.window.close(); marked.window.close(); }
  });

  it('sends a marked new chat and binds the conversation DeepSeek assigns', async () => {
    const sent: string[] = [];
    const dom = signedInDocument(`<!doctype html><body>
      <div class="ds-virtual-list"></div>
      <textarea></textarea>
      <button aria-label="Send">Send</button>
    </body>`, 'https://chat.deepseek.com/?cos-input=new-1#cos-input=new-1');
    const textarea = dom.window.document.querySelector('textarea')!;
    textarea.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      const text = textarea.value;
      sent.push(text);
      textarea.value = '';
      const row = dom.window.document.createElement('div');
      row.className = 'ds-message';
      row.innerHTML = `<div class="ds-collapsible-text">${text.replace(/</g, '&lt;')}</div>`;
      dom.window.document.querySelector('.ds-virtual-list')!.append(row);
      dom.window.history.pushState({}, '', `/a/chat/s/${conversationId}`);
    });
    const fake = silentContents(dom);
    const driver = new DeepSeekPageDriver(fake as any);
    const framed = prependUserPrompt('first task', 'Be terse.');
    mocks.pending.mockResolvedValueOnce([{ id: 'new-1', conversationId: null, lifetime: undefined }]).mockResolvedValue([]);
    mocks.claim.mockResolvedValue({ id: 'new-1', text: framed });

    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(sent).toEqual([framed]);
    expect(mocks.claim).toHaveBeenCalledWith('new-1', 'deepseek-page:7', null);
    expect(mocks.acknowledge).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(mocks.acknowledge).toHaveBeenCalledWith('new-1', 'deepseek-page:7', conversationId,
      deepSeekMessageId(conversationId, 'user', framed));
    expect(sent).toEqual([framed]);
    expect(mocks.fail).not.toHaveBeenCalled();
    driver.stop();
  });

  it('types a broker worker bootstrap and binds the conversation it becomes', async () => {
    const sent: string[] = [];
    const dom = signedInDocument(`<!doctype html><body>
      <div class="ds-virtual-list"></div>
      <textarea></textarea>
      <button aria-label="Send">Send</button>
    </body>`, 'https://chat.deepseek.com/?clf=cmd-1#clf=cmd-1');
    const textarea = dom.window.document.querySelector('textarea')!;
    textarea.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      const text = textarea.value;
      sent.push(text);
      textarea.value = '';
      const row = dom.window.document.createElement('div');
      row.className = 'ds-message';
      row.innerHTML = `<div class="ds-collapsible-text">${text.replace(/</g, '&lt;')}</div>`;
      dom.window.document.querySelector('.ds-virtual-list')!.append(row);
      dom.window.history.pushState({}, '', `/a/chat/s/${conversationId}`);
    });
    const fake = silentContents(dom);
    const workerClaim = vi.fn().mockResolvedValue({ ok: true, text: prependUserPrompt('audit the parser', 'Be terse.') });
    const workerAck = vi.fn().mockResolvedValue({ ok: true });
    setDeepSeekWorkerBridge({ claim: workerClaim, ack: workerAck });
    // An ordinary send waiting beside the worker must not be typed into this page.
    mocks.pending.mockResolvedValue([{ id: 'new-1', conversationId: null, lifetime: undefined }]);
    const driver = new DeepSeekPageDriver(fake as any);

    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(workerClaim).toHaveBeenCalledWith('cmd-1', 'deepseek-page:7');
    expect(sent).toEqual([prependUserPrompt('audit the parser', 'Be terse.')]);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(workerAck).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(workerAck).toHaveBeenCalledWith('cmd-1', 'deepseek-page:7', conversationId);
    driver.stop();
  });

  it("wakes a sleeping worker in its own conversation and retires the wake on the bridge's receipt", async () => {
    const sent: string[] = [];
    const dom = page(question);
    const driver = new DeepSeekPageDriver(contents(dom, sent));
    const claimPending = vi.fn().mockResolvedValue({ ok: true, id: 'wake-1', text: 'now do the second half' });
    const workerAck = vi.fn().mockResolvedValue({ ok: true });
    const failRevival = vi.fn().mockResolvedValue({ ok: true });
    setDeepSeekWorkerBridge({ claim: vi.fn(), ack: workerAck, claimPendingRevival: claimPending, failRevival });

    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(claimPending).toHaveBeenCalledWith(conversationId, 'deepseek-page:7');
    expect(sent).toEqual(['now do the second half']);
    expect(workerAck).toHaveBeenCalledWith('wake-1', 'deepseek-page:7', conversationId);
    expect(failRevival).not.toHaveBeenCalled();

    // A later tick must not type the same wake again, even after its receipt is gone.
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(sent).toEqual(['now do the second half']);
    expect(workerAck).toHaveBeenCalledTimes(1);
    driver.stop();
  });

  it('retries a wake left in the composer without typing or sending it twice', async () => {
    const sent: string[] = [];
    const dom = page(question);
    const driver = new DeepSeekPageDriver(silentContents(dom));
    const claimPending = vi.fn().mockResolvedValue({ ok: true, id: 'wake-retry', text: 'now do the second half' });
    const workerAck = vi.fn().mockResolvedValue({ ok: true });
    setDeepSeekWorkerBridge({ claim: vi.fn(), ack: workerAck, claimPendingRevival: claimPending });

    driver.start();
    // The first attempt sets the composer, but the page has no Send control yet and Enter does
    // not submit. The wake text stays in the textarea.
    await vi.advanceTimersByTimeAsync(4_000);
    await settle();
    expect(sent).toEqual([]);
    expect(dom.window.document.querySelector('textarea')!.value).toBe('now do the second half');

    // The control appears while the retry is settling. The page must send the existing text,
    // not retype it and submit a second copy.
    const button = dom.window.document.createElement('button');
    button.className = 'ds-button--primary';
    button.addEventListener('click', () => {
      sent.push(dom.window.document.querySelector('textarea')!.value);
      dom.window.document.querySelector('textarea')!.value = '';
    });
    dom.window.document.body.append(button);
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();

    expect(sent).toEqual(['now do the second half']);
    expect(workerAck).toHaveBeenCalledWith('wake-retry', 'deepseek-page:7', conversationId);
    driver.stop();
  });

  it('settles a wake that landed during a failed send instead of sending it again', async () => {
    const sent: string[] = [];
    const dom = page(question);
    const driver = new DeepSeekPageDriver(silentContents(dom));
    const claimPending = vi.fn().mockResolvedValue({ ok: true, id: 'wake-landed', text: 'now do the second half' });
    const workerAck = vi.fn().mockResolvedValue({ ok: true });
    setDeepSeekWorkerBridge({ claim: vi.fn(), ack: workerAck, claimPendingRevival: claimPending });

    driver.start();
    await vi.advanceTimersByTimeAsync(4_000);
    await settle();

    const list = dom.window.document.querySelector('.ds-virtual-list')!;
    const row = dom.window.document.createElement('div');
    row.className = 'ds-message';
    row.setAttribute('data-virtual-list-item-key', '3');
    row.innerHTML = '<div class="ds-collapsible-text">now do the second half</div>';
    list.append(row);

    await vi.advanceTimersByTimeAsync(2_000);
    await settle();

    expect(sent).toEqual([]);
    expect(workerAck).toHaveBeenCalledWith('wake-landed', 'deepseek-page:7', conversationId);
    driver.stop();
  });

  it('retries a wake through the composer-unavailable window and sends it once', async () => {
    const sent: string[] = [];
    const dom = signedInDocument(`<!doctype html><body>
      <div class="ds-virtual-list">${question}</div>
    </body>`, `https://chat.deepseek.com/a/chat/s/${conversationId}`);
    const driver = new DeepSeekPageDriver(silentContents(dom));
    const claimPending = vi.fn().mockResolvedValue({ ok: true, id: 'wake-composer', text: 'now do the second half' });
    const workerAck = vi.fn().mockResolvedValue({ ok: true });
    setDeepSeekWorkerBridge({ claim: vi.fn(), ack: workerAck, claimPendingRevival: claimPending });

    driver.start();
    await vi.advanceTimersByTimeAsync(4_000);
    await settle();

    expect(claimPending).toHaveBeenCalled();
    expect(workerAck).not.toHaveBeenCalled();
    expect(dom.window.document.querySelector('textarea')).toBeNull();

    // The page finishes painting its composer while the wake is waiting.
    const textarea = dom.window.document.createElement('textarea');
    textarea.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      sent.push(textarea.value);
      textarea.value = '';
    });
    dom.window.document.body.append(textarea);
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();

    expect(sent).toEqual(['now do the second half']);
    expect(workerAck).toHaveBeenCalledWith('wake-composer', 'deepseek-page:7', conversationId);
    driver.stop();
  });

  it('does not resend a wake when the virtual window shifts its rows', async () => {
    const sent: string[] = [];
    const prior = '<div class="ds-message" data-virtual-list-item-key="2"><div class="ds-collapsible-text">now do the second half</div></div>';
    const dom = signedInDocument(`<!doctype html><body>
      <div class="ds-virtual-list">${question}${prior}</div>
    </body>`, `https://chat.deepseek.com/a/chat/s/${conversationId}`);
    const driver = new DeepSeekPageDriver(silentContents(dom));
    const claimPending = vi.fn().mockResolvedValue({ ok: true, id: 'wake-shifted', text: 'now do the second half' });
    const workerAck = vi.fn().mockResolvedValue({ ok: true });
    setDeepSeekWorkerBridge({ claim: vi.fn(), ack: workerAck, claimPendingRevival: claimPending });

    driver.start();
    await vi.advanceTimersByTimeAsync(4_000);
    await settle();
    expect(workerAck).not.toHaveBeenCalled();

    // The wake landed, and the list dropped the older matching row in the same render. The
    // visible count is unchanged, so only the new absolute key proves delivery.
    const list = dom.window.document.querySelector('.ds-virtual-list')!;
    list.querySelector('[data-virtual-list-item-key="2"]')!.remove();
    const landed = dom.window.document.createElement('div');
    landed.className = 'ds-message';
    landed.setAttribute('data-virtual-list-item-key', '6');
    landed.innerHTML = '<div class="ds-collapsible-text">now do the second half</div>';
    list.append(landed);
    const textarea = dom.window.document.createElement('textarea');
    textarea.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      sent.push(textarea.value);
      textarea.value = '';
    });
    dom.window.document.body.append(textarea);

    await vi.advanceTimersByTimeAsync(2_000);
    await settle();

    expect(sent).toEqual([]);
    expect(workerAck).toHaveBeenCalledWith('wake-shifted', 'deepseek-page:7', conversationId);
    driver.stop();
  });

  it('fails a worker bootstrap on a signed-out page instead of leaving the prime waiting', async () => {
    const dom = new JSDOM('<!doctype html><body><textarea></textarea></body>',
      { url: 'https://chat.deepseek.com/sign_in?clf=cmd-1#clf=cmd-1', runScripts: 'outside-only' });
    const workerClaim = vi.fn().mockResolvedValue({ ok: true, text: 'audit the parser' });
    const workerAck = vi.fn().mockResolvedValue({ ok: true });
    setDeepSeekWorkerBridge({ claim: workerClaim, ack: workerAck });
    const driver = new DeepSeekPageDriver(contents(dom, []));

    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(workerClaim).toHaveBeenCalledWith('cmd-1', 'deepseek-page:7');
    expect(workerAck).toHaveBeenCalledWith('cmd-1', 'deepseek-page:7', null,
      expect.stringContaining('Sign in to DeepSeek'));
    driver.stop();
  });

  it('retries a worker page that is still painting rather than failing its bootstrap', async () => {
    const dom = signedInDocument('<!doctype html><body><div class="ds-virtual-list"></div></body>',
      'https://chat.deepseek.com/?clf=cmd-1#clf=cmd-1');
    const workerClaim = vi.fn().mockResolvedValue({ ok: true, text: 'audit the parser' });
    const workerAck = vi.fn().mockResolvedValue({ ok: true });
    setDeepSeekWorkerBridge({ claim: workerClaim, ack: workerAck });
    const fake = silentContents(dom);
    const driver = new DeepSeekPageDriver(fake as any);

    driver.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();

    expect(workerClaim).toHaveBeenCalled();
    expect(workerAck).not.toHaveBeenCalled();

    const textarea = dom.window.document.createElement('textarea');
    dom.window.document.body.append(textarea);
    const sent: string[] = [];
    textarea.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      sent.push(textarea.value);
      textarea.value = '';
      dom.window.history.pushState({}, '', `/a/chat/s/${conversationId}`);
    });
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(sent).toEqual(['audit the parser']);
    driver.stop();
  });

  it('uses the page send control when Enter leaves the composer filled', async () => {
    const sent: string[] = [];
    const dom = signedInDocument(`<!doctype html><body>
      <div class="ds-virtual-list">${question}</div>
      <textarea></textarea>
      <button class="ds-button--primary" aria-label="Send">Send</button>
    </body>`, `https://chat.deepseek.com/a/chat/s/${conversationId}`);
    const textarea = dom.window.document.querySelector('textarea')!;
    // This build's Enter did not submit, which is exactly the fallback the page-owned send
    // control covers for a worker bootstrap or an ordinary message.
    dom.window.document.querySelector('button')!.addEventListener('click', () => {
      sent.push(textarea.value);
      textarea.value = '';
    });
    const fake = silentContents(dom);
    const driver = new DeepSeekPageDriver(fake as any);
    mocks.pending.mockResolvedValueOnce([{ id: 'input-1', conversationId, lifetime: undefined }]).mockResolvedValue([]);
    mocks.claim.mockResolvedValue({ id: 'input-1', text: 'send through the control' });

    driver.start();
    // Enter's own settle window is 1 s before the page's Send control is tried.
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();

    expect(sent).toEqual(['send through the control']);
    expect(mocks.fail).not.toHaveBeenCalled();
    driver.stop();
  });

  it('fails a message with files visibly instead of sending it without them', async () => {
    const sent: string[] = [];
    const dom = page(question);
    const driver = new DeepSeekPageDriver(contents(dom, sent));
    mocks.pending.mockResolvedValueOnce([{ id: 'input-files', conversationId, lifetime: undefined }]).mockResolvedValue([]);
    mocks.claim.mockResolvedValue({ id: 'input-files', text: 'look at this', attachments: [{ id: 'a1' }] });

    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(sent).toEqual([]);
    expect(mocks.fail).toHaveBeenCalledWith('input-files', 'deepseek-page:7',
      expect.stringContaining('does not accept file attachments'), 'attachments');
    driver.stop();
  });

  it('never types an unmarked new-chat page when more than one send waits', async () => {
    const sent: string[] = [];
    const dom = signedInDocument('<!doctype html><body><div class="ds-virtual-list"></div><textarea></textarea></body>',
      'https://chat.deepseek.com/');
    const driver = new DeepSeekPageDriver(contents(dom, sent));
    mocks.pending.mockResolvedValue([
      { id: 'new-1', conversationId: null, lifetime: undefined },
      { id: 'new-2', conversationId: null, lifetime: undefined }
    ]);

    driver.start();
    await vi.advanceTimersByTimeAsync(1_600);
    await settle();

    expect(sent).toEqual([]);
    expect(mocks.claim).not.toHaveBeenCalled();
    driver.stop();
  });

  it('updates list structure when the visible words stay the same during streaming', async () => {
    const dom = page(question + answer('<p>FirstSecond</p>'), '<button aria-label="Stop generating">Stop</button>');
    Object.defineProperty(dom.window.Element.prototype, 'getClientRects', { value: () => [{ width: 10, height: 10 }] });
    const driver = new DeepSeekPageDriver(contents(dom, []));
    driver.start();
    try {
      await vi.advanceTimersByTimeAsync(800);
      mocks.record.mockClear();
      dom.window.document.querySelector('.ds-assistant-message-main-content')!.innerHTML = '<ul><li>First</li><li>Second</li></ul>';
      await vi.advanceTimersByTimeAsync(800);
      expect(mocks.record.mock.calls.flatMap(call => call[1])).toContainEqual(expect.objectContaining({
        text: 'FirstSecond', textFormat: 'plain', renderedHtml: '<ul><li>First</li><li>Second</li></ul>', final: false
      }));
      expect(mocks.reply).not.toHaveBeenCalled();
    } finally { driver.stop(); dom.window.close(); }
  });

  it('records the question and the answer, and never the reasoning text', async () => {
    const sent: string[] = [];
    const dom = page(question + answer('Two tests failed.'));
    const driver = new DeepSeekPageDriver(contents(dom, sent));

    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    await vi.advanceTimersByTimeAsync(1_700);
    await settle();
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    const stored = mocks.record.mock.calls.flatMap(call => call[1] as Array<Record<string, unknown>>)
      .filter(item => item.kind === 'user_message' || item.final === true);
    expect(stored.map(item => [item.kind, item.text])).toEqual([
      ['user_message', 'run the tests'],
      ['assistant_message', 'Two tests failed.']
    ]);
    expect(JSON.stringify(stored)).not.toContain('weighing the options');
    driver.stop();
  });

  it('marks the answer final once it stops changing, then hands it to the reply path', async () => {
    const sent: string[] = [];
    const dom = page(question + answer('Two tests failed.'));
    const driver = new DeepSeekPageDriver(contents(dom, sent));

    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    mocks.record.mockClear();

    await vi.advanceTimersByTimeAsync(1_700);
    await settle();
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    const finals = mocks.record.mock.calls
      .flatMap(call => call[1] as Array<Record<string, unknown>>)
      .filter(item => item.final === true);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ kind: 'assistant_message', text: 'Two tests failed.', state: 'final' });
    expect(mocks.reply).toHaveBeenCalledOnce();
    expect(mocks.reply).toHaveBeenCalledWith(expect.objectContaining({
      conversationId, text: 'Two tests failed.', final: true
    }));
    driver.stop();
  });

  it('carries a model tool request to the same reply path unchanged', async () => {
    const sent: string[] = [];
    const envelope = '{"type":"tool_calls","calls":[{"id":"c1","name":"read","arguments":{"path":"src/a.ts"}}]}';
    const dom = page(question + answer(envelope));
    const driver = new DeepSeekPageDriver(contents(dom, sent));

    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    await vi.advanceTimersByTimeAsync(1_700);
    await settle();
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(mocks.reply).toHaveBeenCalledWith(expect.objectContaining({ text: envelope, conversationId }));
    driver.stop();
  });

  it('delivers the raw tool envelope instead of the markdown-mangled DOM and keeps its row identity', async () => {
    const args = { cmd: 'printf "hi" \\ *x* __x__ <tag>value</tag>' };
    const raw = JSON.stringify({ type: 'tool_calls', calls: [{ id: 'c1', name: 'exec_command', arguments: args }] });
    const dom = page(question + answer(raw.replace(/\\(["\\])/g, '$1')
      .replace('*x*', '<em>x</em>').replace('__x__', '<strong>x</strong>')));
    const fetchHistory = vi.fn().mockResolvedValue({ ok: true, json: async () => history(raw) });
    dom.window.fetch = fetchHistory;
    const driver = new DeepSeekPageDriver(contents(dom, []));

    driver.start();
    await vi.advanceTimersByTimeAsync(3_500);
    await settle();

    expect(mocks.reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      conversationId, text: raw, textFormat: 'markdown', messageId: `ds:${conversationId}:assistant:row-2`, final: true
    }));
    expect(parseDeepSeekReply(mocks.reply.mock.calls[0]![0].text, new Set(['exec_command'])))
      .toEqual({ kind: 'tool_proposals', calls: [{ id: 'c1', name: 'exec_command', arguments: args }] });
    const assistantRows = mocks.record.mock.calls.flatMap(call => call[1] as Array<Record<string, unknown>>)
      .filter(item => item.kind === 'assistant_message');
    expect(assistantRows.map(item => item.messageId)).toEqual([
      `ds:${conversationId}:assistant:row-2`, `ds:${conversationId}:assistant:row-2`
    ]);
    expect(assistantRows.at(-1)).toMatchObject({ text: raw, final: false });
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    driver.stop();
  });

  it('finalizes a stopped (INCOMPLETE) reply instead of holding the chat forever', async () => {
    const dom = page(question + answer('Cut off'));
    const fetchHistory = vi.fn().mockResolvedValue({ ok: true, json: async () =>
      history('Raw cut off', { role: 'ASSISTANT', status: 'INCOMPLETE', has_pending_fragment: false }) });
    dom.window.fetch = fetchHistory;
    const driver = new DeepSeekPageDriver(contents(dom, []));

    driver.start();
    await vi.advanceTimersByTimeAsync(3_500);
    await settle();

    // Recorded as the turn's end, so the chat is not held, but never parsed for tools or continued.
    const finals = mocks.record.mock.calls.flatMap(call => call[1] as Array<Record<string, unknown>>).filter(item => item.final === true);
    expect(finals).toEqual([expect.objectContaining({ text: 'Raw cut off', final: true })]);
    expect(mocks.reply).not.toHaveBeenCalled();
    driver.stop();
  });

  it.each([
    { role: 'ASSISTANT', status: 'WIP', has_pending_fragment: false },
    { role: 'ASSISTANT', status: 'FINISHED', has_pending_fragment: true },
    { role: 'USER', status: 'FINISHED', has_pending_fragment: false }
  ])('waits for a finished assistant without pending fragments: %j', async active => {
    const dom = page(question + answer('Paused response'));
    const fetchHistory = vi.fn().mockResolvedValue({ ok: true, json: async () => history('Raw response', active) });
    dom.window.fetch = fetchHistory;
    const driver = new DeepSeekPageDriver(contents(dom, []));

    driver.start();
    await vi.advanceTimersByTimeAsync(3_500);
    await settle();

    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.record.mock.calls.flatMap(call => call[1]).filter(item => item.final === true)).toEqual([]);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    // The existing 700 ms poll must not fetch history again before two seconds have passed.
    await vi.advanceTimersByTimeAsync(700);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    fetchHistory.mockResolvedValue({ ok: true, json: async () => history('Raw response') });
    await vi.advanceTimersByTimeAsync(700);
    await settle();

    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(mocks.reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'Raw response', final: true }));
    driver.stop();
  });

  it('holds queued input while history still reports WIP', async () => {
    const sent: string[] = [];
    const dom = page(question + answer('Paused response'));
    dom.window.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => history('Paused response', { status: 'WIP' }) });
    const driver = new DeepSeekPageDriver(contents(dom, sent));
    mocks.pending.mockResolvedValue([{ id: 'after-turn', conversationId }]);
    mocks.claim.mockResolvedValue({ id: 'after-turn', text: 'next task' });

    driver.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(sent).toEqual([]);
    expect(mocks.claim).not.toHaveBeenCalled();
    driver.stop();
  });

  it('keeps the DOM content identity when a keyless answer is finalized with raw text', async () => {
    const dom = page(question + answer('Rendered answer').replace('data-virtual-list-item-key="2"', ''));
    dom.window.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => history('*Rendered* answer') });
    const driver = new DeepSeekPageDriver(contents(dom, []));

    driver.start();
    await vi.advanceTimersByTimeAsync(7_000);
    await settle();

    const messageId = deepSeekMessageId(conversationId, 'assistant', 'Rendered answer');
    expect(mocks.reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: '*Rendered* answer', messageId }));
    const finals = mocks.record.mock.calls.flatMap(call => call[1]).filter(item => item.final === true);
    expect(finals).toEqual([expect.objectContaining({ text: '*Rendered* answer', messageId })]);
    expect(dom.window.fetch).toHaveBeenCalledTimes(1);
    driver.stop();
  });

  it('discards a history read across A to B to A navigation and checks the new incarnation', async () => {
    const dom = page(question + answer('DOM answer'));
    let resolveHistory!: (response: unknown) => void;
    const fetchHistory = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveHistory = resolve; }))
      .mockResolvedValue({ ok: true, json: async () => history('Current answer') });
    dom.window.fetch = fetchHistory;
    const fake = contents(dom, []);
    const driver = new DeepSeekPageDriver(fake);

    driver.start();
    await vi.advanceTimersByTimeAsync(3_500);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    fake.emit('did-start-navigation', { isMainFrame: true });
    dom.window.history.pushState({}, '', '/a/chat/s/another-conversation');
    fake.emit('did-start-navigation', { isMainFrame: true });
    dom.window.history.pushState({}, '', `/a/chat/s/${conversationId}`);
    resolveHistory({ ok: true, json: async () => history('Stale answer') });
    await settle();

    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.record.mock.calls.flatMap(call => call[1]).filter(item => item.final === true)).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_500);
    await settle();
    expect(mocks.reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'Current answer' }));
    driver.stop();
  });

  it('falls back to DOM text on history failure and warns only once per conversation', async () => {
    const dom = page(question + answer('DOM answer'));
    const fetchHistory = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    dom.window.fetch = fetchHistory;
    const driver = new DeepSeekPageDriver(contents(dom, []));

    driver.start();
    await vi.advanceTimersByTimeAsync(3_500);
    await settle();
    expect(mocks.reply).toHaveBeenCalledWith(expect.objectContaining({ text: 'DOM answer', textFormat: 'plain', final: true }));
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining(conversationId));

    dom.window.document.querySelector('.ds-assistant-message-main-content')!.textContent = 'Second DOM answer';
    await vi.advanceTimersByTimeAsync(3_500);
    await settle();
    expect(mocks.reply).toHaveBeenCalledTimes(2);
    expect(mocks.reply).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Second DOM answer', final: true }));
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    driver.stop();
  });

  it('corrects an earlier signed-out read when the SPA writes its token without navigating', async () => {
    const dom = page(question);
    dom.window.localStorage.removeItem('userToken');
    setCosBrowserSignedIn(false);
    const driver = new DeepSeekPageDriver(contents(dom, []));

    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    expect(cosBrowserSignedIn()).toBe(false);
    dom.window.localStorage.setItem('userToken', JSON.stringify({ value: 'synthetic-late-token' }));
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(cosBrowserSignedIn()).toBe(true);

    dom.window.localStorage.removeItem('userToken');
    await vi.advanceTimersByTimeAsync(800);
    expect(cosBrowserSignedIn()).toBe(false);
    driver.stop();
  });

  it('runs a requested tool and types its results back into the page as the continuation', async () => {
    const envelope = '{"type":"tool_calls","calls":[{"id":"c1","name":"read","arguments":{"path":"src/a.ts"}}]}';
    const { runDeepSeekTurn } = await import('../src/main/deepseek/turn.js');
    const ran: string[] = [];
    const outcome = await runDeepSeekTurn(envelope, {
      tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }],
      execute: async call => { ran.push(`${call.name} ${String(call.arguments.path)}`); return { text: 'export const a = 1;', isError: false }; }
    });
    expect(ran).toEqual(['read src/a.ts']);
    if (outcome.status !== 'tools') throw new Error('expected tools');
    expect(outcome.continuation).toContain('export const a = 1;');

    // The page driver claims that continuation from the same outbox and sends it as the next
    // message, which is what makes the turn continue rather than stop at the tool result.
    const sent: string[] = [];
    const dom = page(question);
    const driver = new DeepSeekPageDriver(contents(dom, sent));
    mocks.pending.mockResolvedValueOnce([{ id: 'continuation-1', conversationId, lifetime: undefined }]).mockResolvedValue([]);
    mocks.claim.mockResolvedValue({ id: 'continuation-1', text: outcome.continuation });
    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(sent).toEqual([outcome.continuation]);
    await vi.advanceTimersByTimeAsync(6_200);
    await settle();
    expect(mocks.acknowledge).toHaveBeenCalledWith('continuation-1', 'deepseek-page:7', conversationId, undefined);
    driver.stop();
  });

  it('reads the rate-limit notice but not a transcript that mentions it', () => {
    const visibleRect = () => [{ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, toJSON: () => ({}) }];
    const throttlePage = page(question, '<div class="notice"><span>Messages too frequent. Try again later.</span></div>');
    Object.defineProperty(throttlePage.window.Element.prototype, 'getClientRects', { configurable: true, value: visibleRect });
    expect((throttlePage.window.eval(DEEPSEEK_SNAPSHOT_SCRIPT) as { throttled: boolean }).throttled).toBe(true);

    // The same words inside an answer are transcript content, not page chrome.
    const prose = page(question.replace('run the tests', 'Messages too frequent. Try again later.'));
    Object.defineProperty(prose.window.Element.prototype, 'getClientRects', { configurable: true, value: visibleRect });
    expect((prose.window.eval(DEEPSEEK_SNAPSHOT_SCRIPT) as { throttled: boolean }).throttled).toBe(false);
  });

  it('keeps the exact marked opening queued for sign-in without claiming or failing it', async () => {
    const dom = new JSDOM('<!doctype html><body><textarea></textarea></body>', { url: 'https://chat.deepseek.com/sign_in?cos-input=input-1', runScripts: 'outside-only' });
    const sent: string[] = [];
    const driver = new DeepSeekPageDriver(contents(dom, sent));
    mocks.pending.mockResolvedValue([{ id: 'input-1', conversationId: null }]);

    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(mocks.holdSignIn).toHaveBeenCalledWith('input-1', 'deepseek-page:7');
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    driver.stop();
  });

  it('does not publish a stale sign-in hold after another page proves sign-in', async () => {
    const dom = new JSDOM('<!doctype html><body><textarea></textarea></body>', { url: 'https://chat.deepseek.com/sign_in?cos-input=input-1', runScripts: 'outside-only' });
    const driver = new DeepSeekPageDriver(contents(dom, []));
    mocks.pending.mockImplementation(async () => {
      setCosBrowserSignedIn(true);
      return [{ id: 'input-1', conversationId: null }];
    });
    driver.start();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(mocks.holdSignIn).not.toHaveBeenCalled();
    driver.stop();
  });

  it('ignores a DeepSeek page that is not a conversation, and does nothing on sign-in', async () => {
    const sent: string[] = [];
    const dom = new JSDOM('<!doctype html><body><textarea></textarea></body>', { url: 'https://chat.deepseek.com/sign_in', runScripts: 'outside-only' });
    const driver = new DeepSeekPageDriver(contents(dom, sent));
    mocks.pending.mockResolvedValue([{ id: 'input-1', conversationId, lifetime: undefined }]);

    driver.start();
    await vi.advanceTimersByTimeAsync(1_600);
    await settle();

    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.holdSignIn).not.toHaveBeenCalled();
    driver.stop();
  });
});
