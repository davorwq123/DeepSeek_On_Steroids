import { beforeEach, expect, it, vi } from 'vitest';

/** A retried DeepSeek reply re-delivers its stored continuation and never runs a tool twice. */

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), run: vi.fn(), activeTurnId: 'turn-1' as string | null, sessionReadable: true }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../src/main/session/blocked-chats.js', () => ({ isChatBlocked: () => false }));
vi.mock('../src/main/session/store.js', () => ({
  conversationWasSuperseded: async () => false,
  getSession: async () => {
    if (!mocks.sessionReadable) throw new Error('session read failed');
    return { conversationId: 'a97f3e4c-de96-4fc4-ada0-123456789abc', activeTurnId: mocks.activeTurnId };
  }
}));
vi.mock('../src/main/session/recorder.js', () => ({ recordChatObservations: async () => ({ sessionId: 'session-1' }) }));
vi.mock('../src/main/session/input.js', () => ({ enqueueInput: mocks.enqueue, listInputs: async () => [] }));
vi.mock('../src/main/deepseek/goal.js', () => ({ advanceDeepSeekGoal: vi.fn(async () => undefined) }));
vi.mock('../src/main/deepseek/tool-host.js', () => ({
  createDeepSeekToolHost: () => ({
    tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    run: mocks.run
  }),
  deepSeekToolResultText: (result: { text: string }) => result.text
}));

import { deliverDeepSeekReply, resetDeepSeekReplies, setDeepSeekReplyStopCheck } from '../src/main/deepseek/reply.js';

const reply = {
  conversationId: 'a97f3e4c-de96-4fc4-ada0-123456789abc',
  messageId: 'ds:a97f3e4c-de96-4fc4-ada0-123456789abc:assistant:row-2',
  text: '{"type":"tool_calls","calls":[{"id":"c1","name":"read","arguments":{"path":"src/a.ts"}}]}',
  final: true,
  turnId: 'turn-1'
};

beforeEach(() => {
  resetDeepSeekReplies();
  mocks.activeTurnId = 'turn-1';
  mocks.sessionReadable = true;
  mocks.run.mockReset().mockResolvedValue({ text: 'file contents', isError: false });
  mocks.enqueue.mockReset();
});

it('re-delivers only the continuation after its outbox row failed, running the tool once', async () => {
  mocks.enqueue.mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);

  const first = await deliverDeepSeekReply(reply);
  expect(first).toEqual({ status: 503, body: { error: 'results_not_queued', retryable: true } });
  const second = await deliverDeepSeekReply(reply);
  expect(second.status).toBe(200);

  expect(mocks.run).toHaveBeenCalledOnce();
  expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  const [a, b] = mocks.enqueue.mock.calls.map(call => call[0] as { id: string; text: string });
  expect({ id: b!.id, text: b!.text }).toEqual({ id: a!.id, text: a!.text });
  expect(a!.text).toContain('file contents');
});

it('reports the tool calls on a first successful delivery', async () => {
  mocks.enqueue.mockResolvedValue(undefined);
  const result = await deliverDeepSeekReply(reply);
  expect(result).toMatchObject({ status: 200, body: { ok: true, status: 'tools' } });
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ authoredSource: 'none' }), undefined,
    { transport: 'browser', deepSeekContinuation: { turnId: 'turn-1', messageId: reply.messageId } });
});

it('executes no tool when neither the reply nor the session proves an active turn', async () => {
  mocks.activeTurnId = null;
  expect(await deliverDeepSeekReply({ ...reply, turnId: undefined })).toMatchObject({ body: { status: 'stopped' } });
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it('stops the batch during a call and never queues its late results', async () => {
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let stopped = false;
  setDeepSeekReplyStopCheck(() => stopped);
  mocks.run.mockImplementationOnce(async () => { started(); await gate; return { text: 'late result' }; });
  const pending = deliverDeepSeekReply({ ...reply, text: JSON.stringify({ type: 'tool_calls', calls: [
    { id: 'one', name: 'read', arguments: { path: 'one' } },
    { id: 'two', name: 'read', arguments: { path: 'two' } }
  ] }) });
  await began;
  stopped = true;
  release();
  expect(await pending).toMatchObject({ status: 200, body: { status: 'stopped' } });
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it('never revives a closed turn or requeues its results after a failed save', async () => {
  mocks.enqueue.mockRejectedValueOnce(new Error('disk full'));
  expect((await deliverDeepSeekReply(reply)).status).toBe(503);
  mocks.activeTurnId = null;
  expect(await deliverDeepSeekReply(reply)).toMatchObject({ body: { status: 'stopped' } });
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(mocks.enqueue).toHaveBeenCalledOnce();
});

it('resumes after a temporary ownership-read failure without executing the accepted call twice', async () => {
  mocks.run.mockImplementationOnce(async () => {
    mocks.sessionReadable = false;
    return { text: 'first result, already executed' };
  });
  const batch = { ...reply, text: JSON.stringify({ type: 'tool_calls', calls: [
    { id: 'one', name: 'read', arguments: { path: 'one' } },
    { id: 'two', name: 'read', arguments: { path: 'two' } }
  ] }) };
  expect.soft((await deliverDeepSeekReply(batch)).status).toBe(503);
  mocks.sessionReadable = true;
  expect((await deliverDeepSeekReply(batch)).status).toBe(200);
  expect(mocks.run.mock.calls.map(call => call[1].path)).toEqual(['one', 'two']);
  expect(mocks.enqueue.mock.calls[0]![0].text).toContain('first result, already executed');
});

it('does not discard accepted results when the bounded pending queue is full', async () => {
  mocks.enqueue.mockRejectedValue(new Error('disk full'));
  for (let index = 0; index < 65; index += 1) await deliverDeepSeekReply({ ...reply, messageId: `reply-${index}` });
  expect.soft(mocks.run).toHaveBeenCalledTimes(64);
  mocks.enqueue.mockResolvedValue(undefined);
  expect((await deliverDeepSeekReply({ ...reply, messageId: 'reply-0' })).status).toBe(200);
  expect(mocks.run).toHaveBeenCalledTimes(64);
});

it('releases bounded pending custody only after its original turns have ended', async () => {
  mocks.enqueue.mockRejectedValue(new Error('disk full'));
  for (let index = 0; index < 64; index += 1) await deliverDeepSeekReply({ ...reply, messageId: `reply-${index}` });
  mocks.activeTurnId = 'turn-2';
  mocks.enqueue.mockResolvedValue(undefined);
  expect(await deliverDeepSeekReply({ ...reply, messageId: 'new-turn-reply', turnId: 'turn-2' })).toMatchObject({ body: { status: 'tools' } });
  expect(mocks.run).toHaveBeenCalledTimes(65);
});

it('refuses a changed proposal reusing an accepted reply identity without executing its replacement', async () => {
  mocks.enqueue.mockRejectedValueOnce(new Error('disk full'));
  expect((await deliverDeepSeekReply(reply)).status).toBe(503);
  expect(await deliverDeepSeekReply({ ...reply, text: reply.text.replace('src/a.ts', 'src/b.ts') }))
    .toMatchObject({ status: 409, body: { error: 'reply_identity_changed' } });
  expect(mocks.run).toHaveBeenCalledOnce();
});

it('never assigns a cached result to a newer turn when a retry omitted its turn id', async () => {
  mocks.enqueue.mockRejectedValueOnce(new Error('disk full'));
  expect((await deliverDeepSeekReply(reply)).status).toBe(503);
  mocks.activeTurnId = 'turn-2';
  expect(await deliverDeepSeekReply({ ...reply, turnId: undefined })).toMatchObject({ body: { status: 'stopped' } });
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(mocks.enqueue).toHaveBeenCalledOnce();
});

it("finishes a worker with its tool-free answer and never takes a Goal step in a worker's chat", async () => {
  const { setDeepSeekWorkerFinish } = await import('../src/main/deepseek/reply.js');
  const { advanceDeepSeekGoal } = await import('../src/main/deepseek/goal.js');
  const finish = vi.fn(async () => 'worker' as const);
  setDeepSeekWorkerFinish(finish);
  try {
    const answer = { ...reply, messageId: 'ds:worker:assistant:1', text: 'The parser handles all 14 cases.' };
    expect(await deliverDeepSeekReply(answer)).toMatchObject({ status: 200, body: { status: 'answer', worker: true } });
    expect(finish).toHaveBeenCalledExactlyOnceWith(reply.conversationId, 'The parser handles all 14 cases.');
    expect(advanceDeepSeekGoal).not.toHaveBeenCalled();

    finish.mockResolvedValueOnce('not-durable' as never);
    expect(await deliverDeepSeekReply({ ...answer, messageId: 'ds:worker:assistant:2' }))
      .toEqual({ status: 503, body: { error: 'worker_state_not_durable', retryable: true } });

    finish.mockResolvedValueOnce('not-worker' as never);
    expect(await deliverDeepSeekReply({ ...answer, messageId: 'ds:prime:assistant:3' })).toMatchObject({ status: 200 });
    expect(advanceDeepSeekGoal).toHaveBeenCalledOnce();
  } finally {
    setDeepSeekWorkerFinish(null);
  }
});
