import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTempDir, removeTempDir } from './helpers.js';

// Only execution is replaced. Turn ownership, Stop, durable outbox, receipts and history
// are the production owners, so a passing page simulation cannot hide a closed local turn.
const execution = vi.hoisted(() => vi.fn());
vi.mock('../src/main/deepseek/tool-host.js', () => ({
  createDeepSeekToolHost: () => ({
    tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    run: execution
  }),
  deepSeekToolResultText: (result: { text: string }) => result.text
}));

import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSecretsPath } from '../src/main/secrets.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createSession, flushSessions, getSession, initSessionStore, readEvents, resetSessionStoreForTests } from '../src/main/session/store.js';
import { flushRecorder, resetRecorderForTests } from '../src/main/session/recorder.js';
import { acknowledgeBrowserInput, authorizeBrowserInput, claimBrowserInput, configureInputDelivery, failBrowserInput, listInputs, pendingBrowserInputs, resetInputForTests, SEND_WITHDRAWN } from '../src/main/session/input.js';
import { recordDeliveredInput } from '../src/main/session/input-history.js';
import { deliverDeepSeekReply, resetDeepSeekReplies } from '../src/main/deepseek/reply.js';
import { deepSeekMessageIdAt, deepSeekObservations, type DeepSeekPageSnapshot } from '../src/main/deepseek/page.js';
import { resetGoalStateForTests } from '../src/main/goal.js';
import { recordDeepSeekObservationsForApp as recordChatObservations, resetBridgeForTests, sessionControlsFor, stopSessionTurn } from '../src/main/bridge.js';
import { transcriptEntries } from '../src/shared/markdown-export.js';
import { chronological } from '../src/shared/chronology.js';

const conversationId = 'a97f3e4c-de96-4fc4-ada0-123456789abc';
const turnId = 'ds-turn:one-human-task';
let directory: string;
let sessionId: string;

beforeEach(async () => {
  directory = await makeTempDir('cos-deepseek-continuation-');
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); initSessionStore(directory);
  resetGoalStateForTests(); resetRecorderForTests(); resetInputForTests(); resetDeepSeekReplies();
  await saveConfig(defaultConfig());
  execution.mockReset().mockResolvedValue({ text: 'exact file contents', isError: false });
  configureInputDelivery({ applyAutomation: async () => {}, changed: () => {}, recordDelivered: recordDeliveredInput });
  sessionId = (await createSession({ conversationId, title: 'One task' })).id;
  await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: Date.now(), turnId },
    { kind: 'user_message', time: Date.now(), messageId: 'human-1', text: 'Read the files and finish.' }
  ]);
});
afterEach(async () => {
  await flushRecorder(); await flushSessions(); await flushDurable();
  await resetBridgeForTests();
  resetDeepSeekReplies(); resetInputForTests(); resetRecorderForTests(); resetGoalStateForTests();
  resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

function proposal(round: number) {
  return { conversationId, turnId, messageId: `reply-${round}`, final: true,
    text: JSON.stringify({ type: 'tool_calls', calls: [{ id: `call-${round}`, name: 'read', arguments: { path: `file-${round}` } }] }) };
}

it('records the opening question before its turn, preserving its identity and display order', async () => {
  const chat = randomUUID();
  const snapshot = { conversationId: chat, messages: [
    { role: 'user', key: '1', text: 'An earlier question.' },
    { role: 'assistant', key: '2', text: 'An earlier answer.' },
    { role: 'user', key: '3', text: 'Audit the parser.' },
    { role: 'assistant', key: '4', text: 'Checking the parser.' }
  ] } as DeepSeekPageSnapshot;
  const recorded = await recordChatObservations(chat,
    deepSeekObservations(null, snapshot, Date.now(), false, { live: true }));
  const session = await getSession(recorded.sessionId!);
  expect(session?.activeTurnId).toBeTruthy();
  expect(session?.timelineTurns?.[session.activeTurnId!]?.questionId)
    .toBe(deepSeekMessageIdAt(chat, snapshot.messages, 2));
  expect(chronological(await readEvents(recorded.sessionId!)).flatMap(row =>
    row.kind === 'user_message' || row.kind === 'assistant_message' ? [row.message.text] : [])).toEqual([
    'An earlier question.', 'An earlier answer.', 'Audit the parser.', 'Checking the parser.'
  ]);
});

it('continues several tool rounds through the real outbox while Stop stays available, and completes once', async () => {
  for (let round = 1; round <= 3; round += 1) {
    expect(await deliverDeepSeekReply(proposal(round))).toMatchObject({ body: { status: 'tools' } });
    expect((await getSession(sessionId))?.activeTurnId).toBe(turnId);
    expect(await sessionControlsFor(sessionId)).toMatchObject({ activeTurnId: turnId });
    const [pending] = await pendingBrowserInputs();
    expect(pending).toBeDefined();
    const claimed = await claimBrowserInput(pending!.id, 'page-1', conversationId);
    expect(claimed).toMatchObject({ authoredSource: 'none', requiresAuthorization: true, deepSeekContinuation: { turnId } });
    expect(await claimBrowserInput(pending!.id, 'another-page', conversationId)).toBeNull();
    expect(await authorizeBrowserInput(pending!.id, 'page-1', conversationId)).toBe(true);
    // The page's next provider question is part of this turn, with no second local start.
    const snapshot = { conversationId, messages: [
      { role: 'user', key: `${round * 2 + 1}`, text: claimed!.text },
      { role: 'assistant', key: `${round * 2 + 2}`, text: 'Working.' }
    ] } as DeepSeekPageSnapshot;
    expect(await acknowledgeBrowserInput(pending!.id, 'page-1', conversationId,
      deepSeekMessageIdAt(conversationId, snapshot.messages, 0))).toBe(true);
    await recordChatObservations(conversationId, deepSeekObservations(null, snapshot, Date.now(), false, { activeTurnId: turnId }));
  }
  expect(execution).toHaveBeenCalledTimes(3);
  const history = await readEvents(sessionId);
  expect(history.filter(row => row.kind === 'turn_start')).toHaveLength(1);
  expect(history.filter(row => row.kind === 'turn_end')).toEqual([]);
  const questions = history.filter(row => row.kind === 'user_message');
  expect(questions).toHaveLength(4);
  expect(questions.filter(row => row.inputId)).toEqual([
    expect.objectContaining({ authoredText: '' }), expect.objectContaining({ authoredText: '' }), expect.objectContaining({ authoredText: '' })
  ]);
  expect(transcriptEntries(history).filter(row => row.role === 'user').map(row => row.stored.text)).toEqual(['Read the files and finish.']);

  const final = { conversationId, messages: [
    { role: 'user', key: '7', text: 'internal results' }, { role: 'assistant', key: '8', text: 'Finished and verified.' }
  ] } as DeepSeekPageSnapshot;
  await recordChatObservations(conversationId, deepSeekObservations(final, final, Date.now(), true, { activeTurnId: turnId }));
  expect((await getSession(sessionId))?.activeTurnId).toBeNull();
  expect((await readEvents(sessionId)).filter(row => row.kind === 'turn_end')).toEqual([
    expect.objectContaining({ turnId, outcome: 'completed' })
  ]);
  expect(await pendingBrowserInputs()).toEqual([]);
});

it('Stop between rounds retires the exact unsent continuation, including after outbox reload', async () => {
  await deliverDeepSeekReply(proposal(1));
  const [row] = await listInputs();
  await stopSessionTurn(sessionId, turnId);
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(row!.id, 'page-1', conversationId)).toBeNull();
  expect((await listInputs()).find(input => input.id === row!.id)?.state).toBe('cancelled');
  expect(execution).toHaveBeenCalledOnce();
});

it('a Stop during execution prevents the rest of the batch and late result delivery', async () => {
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  execution.mockImplementationOnce(async () => { started(); await gate; return { text: 'late contents' }; });
  const pending = deliverDeepSeekReply({ ...proposal(1), text: JSON.stringify({ type: 'tool_calls', calls: [
    { id: 'first', name: 'read', arguments: { path: 'one' } },
    { id: 'second', name: 'read', arguments: { path: 'two' } }
  ] }) });
  await began;
  await stopSessionTurn(sessionId, turnId);
  release();
  expect(await pending).toMatchObject({ body: { status: 'stopped' } });
  expect(execution).toHaveBeenCalledOnce();
  expect(await listInputs()).toEqual([]);
});

it('rechecks a claimed continuation before Send when Stop wins during preparation', async () => {
  await deliverDeepSeekReply(proposal(1));
  const [row] = await pendingBrowserInputs();
  expect(await claimBrowserInput(row!.id, 'page-1', conversationId)).not.toBeNull();
  await stopSessionTurn(sessionId, turnId);
  expect(await authorizeBrowserInput(row!.id, 'page-1', conversationId)).toBe(false);
  expect(await pendingBrowserInputs()).toEqual([]);
});

it.each([false, true])('returns a continuation to its original outbox row when navigation wins before Send (authorized=%s)', async authorized => {
  await deliverDeepSeekReply(proposal(1));
  const [row] = await pendingBrowserInputs();
  expect(await claimBrowserInput(row!.id, 'old-document', conversationId)).not.toBeNull();
  if (authorized) expect(await authorizeBrowserInput(row!.id, 'old-document', conversationId)).toBe(true);
  expect(await failBrowserInput(row!.id, 'old-document', SEND_WITHDRAWN, 'navigation')).toBe(true);
  expect((await listInputs()).find(input => input.id === row!.id)).toMatchObject({ state: 'queued', owner: null, deepSeekContinuation: { turnId } });
  expect(await claimBrowserInput(row!.id, 'current-document', conversationId)).not.toBeNull();
  expect(await authorizeBrowserInput(row!.id, 'old-document', conversationId)).toBe(false);
  expect(await authorizeBrowserInput(row!.id, 'current-document', conversationId)).toBe(true);
  expect(execution).toHaveBeenCalledOnce();
});

it('does not borrow a newer turn to send an old result', async () => {
  await deliverDeepSeekReply(proposal(1));
  const [row] = await listInputs();
  await recordChatObservations(conversationId, [{ kind: 'turn_start', time: Date.now(), turnId: randomUUID() }]);
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(row!.id, 'page-1', conversationId)).toBeNull();
});
