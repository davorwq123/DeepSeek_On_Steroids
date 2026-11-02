import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Plan drafts and Goal/Loop decisions ask DeepSeek in a hidden chat of their own: the answer is
 * read from DeepSeek's raw history once it is finished, and the chat is deleted again whatever
 * happened, so a helper never hangs and never clutters the person's sidebar.
 */

const warn = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: warn }));
vi.mock('../src/main/cos-browser/sign-in.js', async importOriginal => ({ ...await importOriginal<object>(), COS_BROWSER_PARTITION: 'persist:test' }));

import { DEEPSEEK_SNAPSHOT_SCRIPT } from '../src/main/deepseek/page.js';
import { askDeepSeekHelper, type HelperPage } from '../src/main/deepseek/helper-chat.js';

const conversationId = 'a97f3e4c-de96-4fc4-ada0-123456789abc';

interface FakeOptions {
  signedIn?: boolean;
  /** History answers in order; the last one repeats. */
  history?: Array<{ status: string; text: string; pending?: boolean }>;
  send?: { ok: boolean; reason: string };
  deleted?: boolean;
  readyAfter?: number;
}

function fakePage(options: FakeOptions = {}) {
  const scripts: string[] = [];
  let sent = false;
  let closed = 0;
  let reads = 0;
  let snapshots = 0;
  const history = options.history ?? [{ status: 'FINISHED', text: '```json\n{"action":"stop","reply":"done"}\n```' }];
  const page: HelperPage = {
    async run<T>(script: string): Promise<T> {
      scripts.push(script);
      if (script === DEEPSEEK_SNAPSHOT_SCRIPT) {
        return { signedIn: options.signedIn ?? true, composerReady: ++snapshots > (options.readyAfter ?? 0), busy: false, conversationId: sent ? conversationId : null } as T;
      }
      if (script.includes('chat_session/delete')) return (options.deleted ?? true) as T;
      if (script.includes('history_messages')) {
        const entry = history[Math.min(reads++, history.length - 1)]!;
        return { ok: true, messageId: 2, role: 'ASSISTANT', status: entry.status, pending: entry.pending ?? false, text: entry.text } as T;
      }
      if (snapshots <= (options.readyAfter ?? 0)) throw new Error('composer has not mounted');
      sent = true;
      return (options.send ?? { ok: true, reason: 'sent' }) as T;
    },
    close: () => { closed += 1; }
  };
  const open = vi.fn(async () => page);
  return {
    open,
    scripts,
    closed: () => closed,
    deletes: () => scripts.filter(script => script.includes('chat_session/delete'))
  };
}

beforeEach(() => { vi.useFakeTimers(); warn.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

async function settle<T>(promise: Promise<T>, ms = 30_000): Promise<{ value?: T; error?: Error }> {
  const result = promise.then(value => ({ value }), (error: Error) => ({ error }));
  await vi.advanceTimersByTimeAsync(ms);
  return result;
}

it('returns the finished answer, publishes its progress and deletes the helper chat', async () => {
  const fake = fakePage({ history: [
    { status: 'WIP', text: '```json', pending: true },
    { status: 'FINISHED', text: '```json\n{"action":"stop","reply":"done"}\n```' }
  ] });
  const publish = vi.fn();
  const result = await settle(askDeepSeekHelper('decide', new AbortController().signal, { model: 'deepseek-v4-pro', reasoningEffort: 'high', publish }, fake.open));

  expect(result.error).toBeUndefined();
  expect(result.value).toContain('"action":"stop"');
  expect(publish.mock.calls.map(call => call[0])).toEqual(['```json', '```json\n{"action":"stop","reply":"done"}\n```']);
  expect(fake.deletes()).toHaveLength(1);
  expect(fake.deletes()[0]).toContain(conversationId);
  expect(fake.closed()).toBe(1);
});

it('says the browser is signed out instead of waiting for an answer that never comes', async () => {
  const fake = fakePage({ signedIn: false });
  const onSentUnanswered = vi.fn();
  const result = await settle(askDeepSeekHelper('decide', new AbortController().signal, { onSentUnanswered }, fake.open));
  expect(onSentUnanswered).not.toHaveBeenCalled();

  expect(result.error?.message).toBe('deepseek_signed_out');
  // Nothing was sent, so there is no chat to delete; the window still closes.
  expect(fake.scripts.some(script => script.includes('history_messages'))).toBe(false);
  expect(fake.deletes()).toEqual([]);
  expect(fake.closed()).toBe(1);
});

it('waits for the composer to mount after the signed-in token becomes readable', async () => {
  const fake = fakePage({ readyAfter: 3 });
  const result = await settle(askDeepSeekHelper('plan this task', new AbortController().signal, {}, fake.open));
  expect(result.error).toBeUndefined();
  expect(result.value).toContain('"action":"stop"');
  expect(fake.closed()).toBe(1);
});

it('fails an answer DeepSeek stopped, and still deletes its chat', async () => {
  const fake = fakePage({ history: [{ status: 'INCOMPLETE', text: '{"action":' }] });
  const result = await settle(askDeepSeekHelper('decide', new AbortController().signal, {}, fake.open));

  expect(result.error?.message).toBe('helper_answer_incomplete');
  expect(fake.deletes()).toHaveLength(1);
  expect(fake.closed()).toBe(1);
});

it('reports a send the page refused', async () => {
  const fake = fakePage({ send: { ok: false, reason: 'composer_missing' } });
  const result = await settle(askDeepSeekHelper('decide', new AbortController().signal, {}, fake.open));

  expect(result.error?.message).toBe('helper_send_failed: composer_missing');
  expect(fake.closed()).toBe(1);
});

it('stops waiting the moment the request is cancelled, deleting the chat it started', async () => {
  const fake = fakePage({ history: [{ status: 'WIP', text: 'thinking', pending: true }] });
  const controller = new AbortController();
  const onSentUnanswered = vi.fn();
  const pending = settle(askDeepSeekHelper('decide', controller.signal, { onSentUnanswered }, fake.open), 3_000);
  await vi.advanceTimersByTimeAsync(2_000);
  controller.abort(new Error('goal_switched_off'));
  const result = await pending;

  expect(result.error?.message).toBe('goal_switched_off');
  // DeepSeek took the prompt and had not answered: the Goal helper learns the size from this.
  expect(onSentUnanswered).toHaveBeenCalledOnce();
  expect(fake.deletes()).toHaveLength(1);
  expect(fake.closed()).toBe(1);
});

it('keeps going when the chat cannot be deleted, and says so in the log', async () => {
  const fake = fakePage({ deleted: false });
  const result = await settle(askDeepSeekHelper('decide', new AbortController().signal, {}, fake.open));

  expect(result.value).toContain('"action":"stop"');
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not delete helper chat'));
});

it('runs helper chats one at a time', async () => {
  const first = fakePage();
  const second = fakePage();
  const a = askDeepSeekHelper('one', new AbortController().signal, {}, first.open);
  const b = askDeepSeekHelper('two', new AbortController().signal, {}, second.open);
  await vi.advanceTimersByTimeAsync(0);
  expect(first.open).toHaveBeenCalledOnce();
  expect(second.open).not.toHaveBeenCalled();
  await settle(Promise.all([a, b]));
  expect(second.open).toHaveBeenCalledOnce();
});
