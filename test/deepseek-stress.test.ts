import { JSDOM } from 'jsdom';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Stress: a long agent run against a simulated DeepSeek page. The page streams each answer in
 * chunks, its history lags behind the DOM, and the model writes its tool requests in every shape
 * it uses. The real page driver and the real turn runner do the work; the outbox is an in-memory
 * one with the same claim and acknowledge contract.
 *
 * What must hold, however long the run: every tool call runs exactly once, in order; every
 * continuation is typed exactly once; nothing runs from a half-written answer; and nothing the
 * chat shows of any answer, at any moment, is protocol text.
 */

const conversationId = 'a97f3e4c-de96-4fc4-ada0-123456789abc';

const mocks = vi.hoisted(() => ({ record: vi.fn(), note: vi.fn(), reply: vi.fn(), warn: vi.fn(), pending: vi.fn(), claim: vi.fn(), ack: vi.fn() }));
vi.mock('../src/main/session/recorder.js', () => ({ recordChatObservations: mocks.record, recordNote: mocks.note }));
vi.mock('../src/main/session/store.js', () => ({ findSessionByConversation: vi.fn(async () => ({ id: 'session-1' })) }));
vi.mock('../src/main/session/input.js', () => ({
  pendingBrowserInputs: mocks.pending,
  claimBrowserInput: mocks.claim,
  acknowledgeBrowserInput: mocks.ack,
  failBrowserInput: vi.fn(async () => true)
}));
vi.mock('../src/main/deepseek/reply.js', () => ({ deliverDeepSeekReply: mocks.reply }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: mocks.warn }));

import { DeepSeekPageDriver, setDeepSeekWorkerBridge } from '../src/main/deepseek/page-driver.js';
import { runDeepSeekTurn } from '../src/main/deepseek/turn.js';
import { deepSeekAnswerText, deepSeekAppMessage } from '../src/shared/deepseek-display.js';

const call = (round: number) => JSON.stringify({ type: 'tool_calls', calls: [{ id: `c${round}`, name: 'read', arguments: { path: `src/file-${round}.ts` } }] });

/** The model's answer for a round, in the shapes DeepSeek writes tool requests. */
function modelAnswer(round: number, rounds: number): string {
  if (round === rounds) return `All ${rounds} files are read. The parser handles every case.`;
  switch (round % 4) {
    case 0: return `Reading file ${round}.\n${call(round)}`;
    case 1: return `Next, file ${round}.\n\n\`\`\`json\n${call(round)}\n\`\`\``;
    case 2: return call(round);
    default: return `Here is what I found so far:\n\n\`\`\`ts\nconst seen = { round: ${round} };\n\`\`\`\n\nNow file ${round}.\n${call(round)}`;
  }
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Message { id: number; role: 'USER' | 'ASSISTANT'; text: string; status: string; pending: boolean }

/** A DeepSeek conversation page: types, streams and finishes like the real one. */
function simulatedPage(rounds: number, options: { historyLagMs: number; chunk: number; chunkMs: number; flakyHistory?: number }) {
  // Seeded, so a failure replays exactly.
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const dom = new JSDOM(`<!doctype html><body><div class="ds-virtual-list"></div><textarea></textarea><button aria-label="Send">Send</button></body>`,
    { url: `https://chat.deepseek.com/a/chat/s/${conversationId}`, runScripts: 'outside-only' });
  const { document } = dom.window;
  dom.window.localStorage.setItem('userToken', JSON.stringify({ value: 'synthetic-page-token' }));
  Object.defineProperty(dom.window.Element.prototype, 'getClientRects', { configurable: true, value: () => [{ width: 10, height: 10 }] });
  const list = document.querySelector('.ds-virtual-list')!;
  const box = document.querySelector('textarea')!;
  const messages: Message[] = [];
  // History is what the server had `historyLagMs` ago: the DOM is always a little ahead.
  let served: Message[] = [];
  const typed: string[] = [];
  let round = 0;

  const row = (message: Message): HTMLElement => {
    const element = document.createElement('div');
    element.className = 'ds-message';
    element.setAttribute('data-virtual-list-item-key', String(message.id));
    element.innerHTML = message.role === 'USER'
      ? `<div class="ds-collapsible-text">${escape(message.text)}</div>`
      : `<div class="ds-markdown ds-assistant-message-main-content">${escape(message.text)}</div>`;
    list.append(element);
    return element;
  };
  const snapshotHistory = () => {
    const copy = messages.map(message => ({ ...message }));
    setTimeout(() => { served = copy; }, options.historyLagMs);
  };

  function stream(full: string): void {
    const message: Message = { id: messages.length + 1, role: 'ASSISTANT', text: '', status: 'WIP', pending: true };
    messages.push(message);
    const stop = document.createElement('button');
    stop.setAttribute('aria-label', 'Stop generating');
    document.body.append(stop);
    const element = row(message);
    const content = element.querySelector('.ds-markdown')!;
    let stopped = false;
    // DeepSeek's Stop ends the generation where it is.
    stop.addEventListener('click', () => {
      stopped = true;
      message.status = 'INCOMPLETE';
      message.pending = false;
      stop.remove();
      snapshotHistory();
    });
    const next = () => {
      if (stopped) return;
      message.text = full.slice(0, message.text.length + options.chunk);
      content.textContent = message.text;
      if (message.text.length >= full.length) {
        message.status = 'FINISHED';
        message.pending = false;
        stop.remove();
      } else setTimeout(next, options.chunkMs);
      snapshotHistory();
    };
    setTimeout(next, options.chunkMs);
  }

  box.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key !== 'Enter' || !box.value) return;
    const text = box.value;
    box.value = '';
    typed.push(text);
    const message: Message = { id: messages.length + 1, role: 'USER', text, status: 'FINISHED', pending: false };
    messages.push(message);
    row(message);
    snapshotHistory();
    round += 1;
    stream(modelAnswer(round, rounds));
  });

  dom.window.fetch = vi.fn(async () => options.flakyHistory && random() < options.flakyHistory ? { ok: false, json: async () => null } : ({
    ok: true,
    json: async () => served.length
      ? { code: 0, data: { biz_code: 0, biz_data: {
        chat_session: { id: conversationId, current_message_id: served.at(-1)!.id },
        chat_messages: served.map(message => ({ message_id: message.id, parent_id: message.id - 1 || null, role: message.role,
          status: message.status, has_pending_fragment: message.pending, fragments: [{ type: message.role === 'USER' ? 'REQUEST' : 'RESPONSE', content: message.text }] }))
      } } }
      : { code: 0, data: { biz_code: 0, biz_data: { chat_session: { id: conversationId, current_message_id: null }, chat_messages: [] } } }
  })) as any;

  const contents = Object.assign(new EventEmitter(), {
    id: 9,
    isDestroyed: () => false,
    getURL: () => dom.window.location.href,
    executeJavaScript: async (script: string) => dom.window.eval(script)
  });
  return { dom, contents, typed, messages, rounds: () => round };
}

/** The app's side: an outbox, a tool that counts its runs, and the real turn runner. */
function app() {
  const outbox: Array<{ id: string; text: string; claimed: boolean; acked: boolean }> = [];
  const runs: string[] = [];
  const replies: Array<{ messageId: string; text: string; final: boolean }> = [];
  mocks.pending.mockImplementation(async () => outbox.filter(row => !row.acked).map(row => ({ id: row.id, conversationId, lifetime: undefined })));
  mocks.claim.mockImplementation(async (id: string) => {
    const row = outbox.find(item => item.id === id && !item.claimed && !item.acked);
    if (!row) return null;
    row.claimed = true;
    return { id: row.id, text: row.text };
  });
  mocks.ack.mockImplementation(async (id: string) => {
    const row = outbox.find(item => item.id === id);
    if (row) row.acked = true;
    return Boolean(row);
  });
  mocks.reply.mockImplementation(async (reply: { messageId: string; text: string; final: boolean }) => {
    replies.push(reply);
    const outcome = await runDeepSeekTurn(reply.text, {
      tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
      execute: async request => { runs.push(String(request.id)); return { text: `contents of ${String(request.arguments.path)}`, isError: false }; }
    });
    if (outcome.status === 'tools') {
      outbox.push({ id: `continuation-${outbox.length + 1}`, text: outcome.continuation, claimed: false, acked: false });
      return { status: 200, body: { ok: true, status: 'tools' } };
    }
    return { status: 200, body: { ok: true, status: outcome.status } };
  });
  return { outbox, runs, replies };
}

let driver: DeepSeekPageDriver | undefined;
let page: ReturnType<typeof simulatedPage> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.record.mockResolvedValue({ sessionId: 'session-1' });
  mocks.note.mockResolvedValue(undefined);
});
afterEach(() => { driver?.stop(); page?.dom.window.close(); setDeepSeekWorkerBridge(null); vi.useRealTimers(); });

it.each([
  { name: 'a fast page', rounds: 12, historyLagMs: 0, chunk: 40, chunkMs: 150 },
  { name: 'a slow page whose history lags', rounds: 12, historyLagMs: 1_500, chunk: 7, chunkMs: 400 },
  { name: 'a long run', rounds: 30, historyLagMs: 600, chunk: 25, chunkMs: 250 }
])('runs every tool exactly once and never shows the protocol: $name', async ({ rounds, historyLagMs, chunk, chunkMs }) => {
  page = simulatedPage(rounds, { historyLagMs, chunk, chunkMs });
  const state = app();
  driver = new DeepSeekPageDriver(page.contents as any);
  // The person's first message, delivered the way the app delivers every message.
  state.outbox.push({ id: 'first', text: 'Read the files one at a time, then summarise.', claimed: false, acked: false });

  driver.start();
  for (let step = 0; step < 400 && page.rounds() <= rounds; step += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    const last = page.messages.at(-1);
    if (page.rounds() === rounds && last?.role === 'ASSISTANT' && last.status === 'FINISHED' && state.replies.some(reply => reply.final && !reply.text.includes('tool_calls'))) break;
  }
  await vi.advanceTimersByTimeAsync(10_000);

  // Every round's call ran once, in order, and the run ended with the plain answer.
  expect(state.runs).toEqual(Array.from({ length: rounds - 1 }, (_, index) => `c${index + 1}`));
  expect(page.rounds()).toBe(rounds);
  // The first message and one continuation per tool round, each typed exactly once.
  expect(page.typed).toHaveLength(rounds);
  expect(new Set(page.typed).size).toBe(rounds);
  expect(page.typed.slice(1).every(text => deepSeekAppMessage(text)?.kind === 'tool-results')).toBe(true);
  // Only finished answers reach the reply path, each once.
  expect(state.replies.every(reply => reply.final)).toBe(true);
  expect(new Set(state.replies.map(reply => reply.messageId)).size).toBe(state.replies.length);
  expect(state.replies).toHaveLength(rounds);
  expect(mocks.note).not.toHaveBeenCalled();

  // Everything the chat was given to draw, partial or final, shows no protocol.
  const drawn = mocks.record.mock.calls.flatMap(call => call[1] as Array<{ kind: string; text?: string; final?: boolean }>)
    .filter(item => item.kind === 'assistant_message' && typeof item.text === 'string');
  expect(drawn.length).toBeGreaterThan(rounds);
  for (const item of drawn) {
    expect(deepSeekAnswerText(item.text!, !item.final), item.text).not.toMatch(/tool_calls|"type"|```json|\{\s*"?$|[`<[]$/);
  }
}, 60_000);

it('reads through a history endpoint that fails a third of the time', async () => {
  page = simulatedPage(10, { historyLagMs: 300, chunk: 20, chunkMs: 200, flakyHistory: 0.33 });
  const state = app();
  driver = new DeepSeekPageDriver(page.contents as any);
  state.outbox.push({ id: 'first', text: 'Go.', claimed: false, acked: false });
  driver.start();
  for (let step = 0; step < 300 && state.runs.length < 9; step += 1) await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(15_000);

  expect(state.runs).toEqual(Array.from({ length: 9 }, (_, index) => `c${index + 1}`));
  expect(page.typed).toHaveLength(10);
  expect(new Set(state.replies.map(reply => reply.messageId)).size).toBe(state.replies.length);
}, 60_000);

it('runs nothing from an answer the person stopped mid-request, then carries on when asked', async () => {
  page = simulatedPage(6, { historyLagMs: 200, chunk: 6, chunkMs: 300 });
  const state = app();
  let stopRequested = false;
  const ackStop = vi.fn(async () => ({ ok: true }));
  setDeepSeekWorkerBridge({ claim: vi.fn(), ack: vi.fn(), ackStop,
    claimPendingStop: vi.fn(async () => {
      if (!stopRequested) return { ok: false, error: 'none' };
      stopRequested = false;
      return { ok: true, id: 'stop-1', turnId: 'turn-1' };
    }) } as any);
  driver = new DeepSeekPageDriver(page.contents as any);
  state.outbox.push({ id: 'first', text: 'Go.', claimed: false, acked: false });
  driver.start();

  // Wait until round 3's request is half written, then press Stop.
  for (let step = 0; step < 300; step += 1) {
    await vi.advanceTimersByTimeAsync(250);
    const last = page.messages.at(-1);
    if (page.rounds() === 3 && last?.role === 'ASSISTANT' && last.text.includes('"calls"')) break;
  }
  expect(page.rounds()).toBe(3);
  stopRequested = true;
  await vi.advanceTimersByTimeAsync(10_000);

  expect(ackStop).toHaveBeenCalledWith('stop-1', 'deepseek-page:9', conversationId, 'turn-1', true, undefined);
  expect(page.messages.at(-1)!.status).toBe('INCOMPLETE');
  expect(state.runs).toEqual(['c1', 'c2']);
  expect(page.typed).toHaveLength(3);
  expect(mocks.note.mock.calls.map(call => call[1])).toEqual(['This reply was cut off before it finished, so its tool requests were not run.']);

  // The person asks to continue: the run picks up from round 4 and finishes.
  state.outbox.push({ id: 'resume', text: 'Continue.', claimed: false, acked: false });
  for (let step = 0; step < 300 && state.runs.length < 4; step += 1) await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(state.runs).toEqual(['c1', 'c2', 'c4', 'c5']);
  expect(page.rounds()).toBe(6);
  expect(page.typed.filter(text => text === 'Continue.')).toHaveLength(1);
}, 60_000);
