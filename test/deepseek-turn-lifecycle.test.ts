import { JSDOM } from 'jsdom';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * A DeepSeek turn ends exactly once, in the right state: a Stop stops the page, a stopped or
 * cut-off answer runs no tools, and a finished answer stays in the driver's custody until it is
 * recorded and handed over, or the chat says it could not be.
 */

const conversationId = 'a97f3e4c-de96-4fc4-ada0-123456789abc';
const envelope = '{"type":"tool_calls","calls":[{"id":"c1","name":"read","arguments":{"path":"src/a.ts"}}]}';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  note: vi.fn(),
  pending: vi.fn(),
  claim: vi.fn(),
  acknowledge: vi.fn(),
  reply: vi.fn(),
  warn: vi.fn()
}));
vi.mock('../src/main/session/recorder.js', () => ({ recordChatObservations: mocks.record, recordNote: mocks.note }));
vi.mock('../src/main/session/store.js', () => ({ findSessionByConversation: vi.fn(async () => ({ id: 'session-1' })) }));
vi.mock('../src/main/session/input.js', () => ({
  pendingBrowserInputs: mocks.pending,
  claimBrowserInput: mocks.claim,
  acknowledgeBrowserInput: mocks.acknowledge,
  failBrowserInput: vi.fn(async () => true)
}));
vi.mock('../src/main/deepseek/reply.js', () => ({ deliverDeepSeekReply: mocks.reply }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: mocks.warn }));

import { DeepSeekPageDriver, setDeepSeekWorkerBridge } from '../src/main/deepseek/page-driver.js';

const question = '<div class="ds-message" data-virtual-list-item-key="1"><div class="ds-collapsible-text">run the tests</div></div>';
const answer = (text: string) =>
  `<div class="ds-message" data-virtual-list-item-key="2"><div class="ds-markdown ds-assistant-message-main-content">${text}</div></div>`;

function history(text: string, status = 'FINISHED') {
  return { code: 0, data: { biz_code: 0, biz_data: {
    chat_session: { id: conversationId, current_message_id: 2 },
    chat_messages: [{ message_id: 2, parent_id: 1, role: 'ASSISTANT', status, has_pending_fragment: false,
      fragments: [{ type: 'RESPONSE', content: text }] }]
  } } };
}

let dom: JSDOM;
let driver: DeepSeekPageDriver;

function mount(text: string, status = 'FINISHED', stop = false): { sent: string[]; stopClicks: () => number; contents: EventEmitter } {
  dom = new JSDOM(`<!doctype html><body>
    <div class="ds-virtual-list">${question}${answer(text)}</div>
    <textarea></textarea>
    <button aria-label="Send">Send</button>
    ${stop ? '<button id="stop" aria-label="Stop generating"></button>' : ''}
  </body>`, { url: `https://chat.deepseek.com/a/chat/s/${conversationId}`, runScripts: 'outside-only' });
  dom.window.localStorage.setItem('userToken', JSON.stringify({ value: 'synthetic-page-token' }));
  // jsdom lays nothing out; every element counts as on screen, so the Stop control is visible.
  Object.defineProperty(dom.window.Element.prototype, 'getClientRects', { configurable: true, value: () => [{ width: 10, height: 10 }] });
  dom.window.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => history(text, status) }) as any;
  let clicks = 0;
  // DeepSeek's Stop ends the generation: the control goes away and the page is idle.
  dom.window.document.getElementById('stop')?.addEventListener('click', event => {
    clicks += 1;
    (event.currentTarget as HTMLElement).remove();
  });
  const sent: string[] = [];
  const box = dom.window.document.querySelector('textarea')!;
  box.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key !== 'Enter') return;
    sent.push(box.value);
    // The page draws the question it took, as DeepSeek does.
    const row = dom.window.document.createElement('div');
    row.className = 'ds-message';
    row.setAttribute('data-virtual-list-item-key', String(3 + sent.length));
    row.innerHTML = '<div class="ds-collapsible-text"></div>';
    row.firstElementChild!.textContent = box.value;
    dom.window.document.querySelector('.ds-virtual-list')!.append(row);
    box.value = '';
  });
  const contents = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    getURL: () => dom.window.location.href,
    executeJavaScript: async (script: string) => dom.window.eval(script)
  });
  driver = new DeepSeekPageDriver(contents as any);
  return { sent, stopClicks: () => clicks, contents };
}

const finals = () => mocks.record.mock.calls.flatMap(call => call[1] as Array<Record<string, unknown>>).filter(item => item.final === true);
const notes = () => mocks.note.mock.calls.map(call => call[1] as string);

beforeEach(() => {
  vi.useFakeTimers();
  mocks.record.mockReset().mockResolvedValue({ sessionId: 'session-1' });
  mocks.note.mockReset().mockResolvedValue(undefined);
  mocks.pending.mockReset().mockResolvedValue([]);
  mocks.claim.mockReset();
  mocks.acknowledge.mockReset().mockResolvedValue(true);
  mocks.reply.mockReset().mockResolvedValue({ status: 200, body: { ok: true, status: 'tools' } });
  mocks.warn.mockReset();
});
afterEach(() => { driver?.stop(); dom?.window.close(); setDeepSeekWorkerBridge(null); vi.useRealTimers(); });

it("clicks the page's own Stop mid-stream, records the turn as stopped and runs no tools", async () => {
  const page = mount(envelope, 'FINISHED', true);
  const ackStop = vi.fn(async () => ({ ok: true }));
  const claimPendingStop = vi.fn()
    .mockResolvedValueOnce({ ok: true, id: 'stop-1', turnId: 'turn-1' })
    .mockResolvedValue({ ok: false, error: 'no_pending_stop' });
  setDeepSeekWorkerBridge({ claim: vi.fn(), ack: vi.fn(), claimPendingStop, ackStop });

  driver.start();
  await vi.advanceTimersByTimeAsync(800);
  await vi.advanceTimersByTimeAsync(600);
  expect(page.stopClicks()).toBe(1);
  expect(ackStop).toHaveBeenCalledExactlyOnceWith('stop-1', 'deepseek-page:7', conversationId, 'turn-1', true, undefined);

  // Even though DeepSeek's history calls the answer FINISHED, the person stopped this turn.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(finals()).toHaveLength(1);
  expect(mocks.reply).not.toHaveBeenCalled();
  expect(notes()).toEqual(['This reply was cut off before it finished, so its tool requests were not run.']);
});

it('reports a Stop whose control is missing and still discards the rest of the reply', async () => {
  mount(envelope, 'FINISHED', false);
  // Busy from a label the click script would find, but which ignores clicks: the page keeps writing.
  const stuck = dom.window.document.createElement('div');
  stuck.setAttribute('aria-label', 'Stop');
  stuck.addEventListener('click', event => event.stopImmediatePropagation());
  dom.window.document.body.append(stuck);
  const ackStop = vi.fn(async () => ({ ok: true }));
  setDeepSeekWorkerBridge({ claim: vi.fn(), ack: vi.fn(), ackStop,
    claimPendingStop: vi.fn().mockResolvedValueOnce({ ok: true, id: 'stop-1', turnId: 'turn-1' }).mockResolvedValue({ ok: false, error: 'none' }) });

  driver.start();
  await vi.advanceTimersByTimeAsync(7_000);
  expect(ackStop).toHaveBeenCalledExactlyOnceWith('stop-1', 'deepseek-page:7', conversationId, 'turn-1', false, 'native_stop_unconfirmed');
  expect(notes()).toContain("DeepSeek's Stop button did not respond; the rest of this reply is ignored.");

  // The page finally goes quiet: the answer is recorded, its tool request is not run.
  stuck.remove();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(finals()).toHaveLength(1);
  expect(mocks.reply).not.toHaveBeenCalled();
});

it('never confirms Stop from an idle page reached by A to B to A navigation', async () => {
  const page = mount(envelope, 'FINISHED', true);
  const ackStop = vi.fn(async () => ({ ok: true }));
  setDeepSeekWorkerBridge({ claim: vi.fn(), ack: vi.fn(), ackStop,
    claimPendingStop: vi.fn().mockResolvedValueOnce({ ok: true, id: 'stop-1', turnId: 'turn-1' }) });
  dom.window.document.getElementById('stop')!.addEventListener('click', () => {
    page.contents.emit('did-start-navigation', { isMainFrame: true });
    dom.window.history.pushState({}, '', '/a/chat/s/different-conversation');
    page.contents.emit('did-start-navigation', { isMainFrame: true });
    dom.window.history.pushState({}, '', `/a/chat/s/${conversationId}`);
  });
  driver.start();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(page.stopClicks()).toBe(1);
  expect(ackStop).not.toHaveBeenCalled();
  expect(mocks.record.mock.calls.flatMap(call => call[1]).some(item => item.kind === 'turn_end')).toBe(false);
});

it('executes nothing from an incomplete reply that contains a tool_calls envelope', async () => {
  mount(envelope, 'INCOMPLETE');

  driver.start();
  await vi.advanceTimersByTimeAsync(5_000);

  expect(finals()).toHaveLength(1);
  expect(finals()[0]).toMatchObject({ text: envelope });
  expect(mocks.reply).not.toHaveBeenCalled();
  expect(notes()).toEqual(['This reply was cut off before it finished, so its tool requests were not run.']);
});

it('retries a failed record, then delivers the reply exactly once', async () => {
  mount(envelope);
  let failed = false;
  mocks.record.mockImplementation(async (_id: string, items: Array<{ kind?: string }>) => {
    if (items.some(item => item.kind === 'turn_start') && !failed) {
      failed = true;
      throw new Error('disk full');
    }
    return { sessionId: 'session-1' };
  });

  driver.start();
  await vi.advanceTimersByTimeAsync(5_000);

  expect(failed).toBe(true);
  expect(mocks.reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conversationId, text: envelope, final: true }));
  expect(notes()).toEqual([]);
});

it('retries a reply whose results were not stored and stops once it is', async () => {
  mount(envelope);
  mocks.reply
    .mockResolvedValueOnce({ status: 503, body: { error: 'results_not_queued', retryable: true } })
    .mockResolvedValue({ status: 200, body: { ok: true, status: 'requeued' } });

  driver.start();
  await vi.advanceTimersByTimeAsync(8_000);

  expect(mocks.reply).toHaveBeenCalledTimes(2);
  expect(mocks.reply.mock.calls[0]![0].messageId).toBe(mocks.reply.mock.calls[1]![0].messageId);
  expect(notes()).toEqual([]);
});

it('gives up with one visible note and releases the turn when every retry fails', async () => {
  const page = mount(envelope);
  mocks.reply.mockResolvedValue({ status: 503, body: { error: 'results_not_queued', retryable: true } });

  driver.start();
  await vi.advanceTimersByTimeAsync(5_000);
  // Custody holds the chat: nothing new is typed while the hand-off is retried.
  mocks.pending.mockResolvedValueOnce([{ id: 'next', conversationId }]).mockResolvedValue([]);
  mocks.claim.mockResolvedValue({ id: 'next', text: 'carry on' });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(page.sent).toEqual([]);

  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.reply).toHaveBeenCalledTimes(6);
  expect(notes()).toEqual(["This reply's results could not be saved after several tries. Send a message to continue."]);
  // Released: the next message goes out.
  expect(page.sent).toEqual(['carry on']);
});

it("tells the broker while the page is writing, so a worker thinking without tools is not put to sleep", async () => {
  mount('Thinking it through', 'WIP', true);
  const noteActivity = vi.fn(async () => undefined);
  setDeepSeekWorkerBridge({ claim: vi.fn(), ack: vi.fn(), noteActivity });

  driver.start();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(noteActivity).toHaveBeenCalledWith(conversationId, true);
  const marks = noteActivity.mock.calls.length;
  // Still running: renewed, not repeated on every poll.
  await vi.advanceTimersByTimeAsync(11_000);
  expect(noteActivity.mock.calls.length).toBeGreaterThan(marks);
  expect(noteActivity.mock.calls.length).toBeLessThan(6);

  dom.window.document.getElementById('stop')!.remove();
  await vi.advanceTimersByTimeAsync(1_500);
  expect(noteActivity).toHaveBeenLastCalledWith(conversationId, false);
});
