import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSecretsPath } from '../src/main/secrets.js';
import { initSkillsPath } from '../src/main/skills.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { createSession, flushSessions, getSession, initSessionStore, readEvents, resetSessionStoreForTests } from '../src/main/session/store.js';
import { flushRecorder, resetRecorderForTests } from '../src/main/session/recorder.js';
import { configureInputDelivery, enqueueInput, listInputs, resetInputForTests } from '../src/main/session/input.js';
import { recordDeliveredInput } from '../src/main/session/input-history.js';
import { resetGoalStateForTests } from '../src/main/goal.js';
import { resetDeepSeekReplies } from '../src/main/deepseek/reply.js';
import { DeepSeekPageDriver, setDeepSeekWorkerBridge } from '../src/main/deepseek/page-driver.js';
import { ackStopForApp, claimPendingStopForApp, recordDeepSeekObservationsForApp, resetBridgeForTests, sessionControlsFor, stopSessionTurn } from '../src/main/bridge.js';
import { transcriptEntries } from '../src/shared/markdown-export.js';

// Only DeepSeek's provider page is simulated. The page scripts, driver, shell process,
// tool kernel, permissions, history, outbox, authorization and Stop command are real.
const conversationId = 'a97f3e4c-de96-4fc4-ada0-123456789abc';
let directory: string;
let sessionId: string;
let dom: JSDOM;
let driver: DeepSeekPageDriver;
let typed: string[];
let replies: string[];
let provider: { role: string; status: string; text: string; id: number };
let suspendOnQueuedResults: boolean;

function row(role: 'user' | 'assistant', text: string): HTMLElement {
  const element = dom.window.document.createElement('div');
  element.className = 'ds-message';
  const id = dom.window.document.querySelectorAll('.ds-message').length + 1;
  element.setAttribute('data-virtual-list-item-key', String(id));
  const body = dom.window.document.createElement('div');
  body.className = role === 'user' ? 'ds-collapsible-text' : 'ds-markdown ds-assistant-message-main-content';
  body.textContent = text;
  element.append(body);
  dom.window.document.querySelector('.ds-virtual-list')!.append(element);
  return element;
}

function respond(text: string, busy = false): void {
  const answer = row('assistant', text);
  provider = { role: 'ASSISTANT', status: busy ? 'WIP' : 'FINISHED', text, id: Number(answer.dataset.virtualListItemKey) };
  if (busy) {
    const stop = dom.window.document.createElement('button');
    stop.id = 'native-stop'; stop.setAttribute('aria-label', 'Stop generating');
    stop.onclick = () => { provider.status = 'INCOMPLETE'; stop.remove(); };
    dom.window.document.body.append(stop);
  }
}

const tools = (calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) => JSON.stringify({ type: 'tool_calls', calls });
const command = (cmd: string) => ({ id: 'shell', name: 'exec_command', arguments: { cmd, workdir: directory, yield_time_ms: 1000, max_output_tokens: 1000 } });
const wait = (check: () => unknown | Promise<unknown>) => vi.waitFor(check, { timeout: 15_000, interval: 40 });

function pageDriver(): DeepSeekPageDriver {
  return new DeepSeekPageDriver(Object.assign(new EventEmitter(), {
    id: 71, isDestroyed: () => false, getURL: () => dom.window.location.href,
    executeJavaScript: async (script: string) => dom.window.eval(script)
  }) as any);
}

beforeEach(async () => {
  directory = await makeTempDir('cos-deepseek-runtime-');
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); initSessionStore(directory);
  await initSkillsPath(directory);
  resetBridgeForTests(); resetGoalStateForTests(); resetRecorderForTests(); resetInputForTests(); resetDeepSeekReplies();
  const config = defaultConfig();
  await saveConfig({ ...config, roots: [{ name: 'fixture', path: directory }], multiAgent: { ...config.multiAgent, enabled: false } });
  suspendOnQueuedResults = false;
  configureInputDelivery({ applyAutomation: async () => {}, changed: () => {
    if (suspendOnQueuedResults) driver?.stop();
  }, recordDelivered: recordDeliveredInput });
  sessionId = (await createSession({ conversationId, title: 'Runtime audit' })).id;
  setDeepSeekWorkerBridge({
    observe: recordDeepSeekObservationsForApp,
    claim: async () => ({ ok: false, error: 'no_worker' }), ack: async () => ({ ok: false }),
    claimPendingStop: claimPendingStopForApp, ackStop: ackStopForApp
  });
  dom = new JSDOM('<body><div class="ds-virtual-list"></div><textarea></textarea><button aria-label="Send">Send</button></body>',
    { url: `https://chat.deepseek.com/a/chat/s/${conversationId}`, runScripts: 'outside-only' });
  dom.window.localStorage.setItem('userToken', JSON.stringify({ value: 'synthetic-provider-token' }));
  Object.defineProperty(dom.window.Element.prototype, 'getClientRects', { value: () => [{ width: 10, height: 10 }] });
  row('user', 'Execute the task and verify it.');
  provider = { role: 'USER', status: 'FINISHED', text: 'Execute the task and verify it.', id: 1 };
  dom.window.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { biz_code: 0, biz_data: {
    chat_session: { id: conversationId, current_message_id: provider.id }, chat_messages: [{
      message_id: provider.id, parent_id: provider.id - 1, role: provider.role, status: provider.status,
      has_pending_fragment: false, fragments: [{ type: provider.role === 'USER' ? 'REQUEST' : 'RESPONSE', content: provider.text }]
    }]
  } } }) })) as any;
  typed = []; replies = [];
  const box = dom.window.document.querySelector('textarea')!;
  box.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !box.value) return;
    const text = box.value; box.value = ''; typed.push(text); row('user', text);
    const next = replies.shift();
    if (next) respond(next);
  });
  driver = pageDriver();
  driver.start();
  await wait(async () => expect((await getSession(sessionId))?.activeTurnId).toBeTruthy());
});

afterEach(async () => {
  driver?.stop(); dom?.window.close(); setDeepSeekWorkerBridge(null);
  await unifiedExecManager.terminateAllProcesses();
  await flushRecorder(); await flushSessions(); await flushDurable();
  resetBridgeForTests(); resetInputForTests(); resetRecorderForTests(); resetGoalStateForTests();
  resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

it('delivers an opening through the real outbox when a composerless unmarked page polls before its marked page', async () => {
  driver.stop();
  const opening = await enqueueInput({ id: '48a06456-93cf-439c-bcb2-84322636f13a', sessionId: null,
    text: 'Start this exact task', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null }, undefined, { transport: 'browser' });
  const strayPage = new JSDOM('<p>No composer here</p>', { url: 'https://chat.deepseek.com/', runScripts: 'outside-only' });
  strayPage.window.localStorage.setItem('userToken', '{"value":"synthetic-provider-token"}');
  let reads = 0;
  const stray = new DeepSeekPageDriver(Object.assign(new EventEmitter(), {
    id: 72, isDestroyed: () => false, getURL: () => strayPage.window.location.href,
    executeJavaScript: async (script: string) => { reads += 1; return strayPage.window.eval(script); }
  }) as any);
  stray.start();
  try {
    // A second poll proves the first one's asynchronous claim work has already finished.
    await wait(() => expect(reads).toBeGreaterThanOrEqual(3));
    expect((await listInputs()).find(input => input.id === opening.id)).toMatchObject({ state: 'queued', owner: null });
    dom.window.document.querySelector('.ds-virtual-list')!.replaceChildren();
    dom.window.history.replaceState({}, '', `/?cos-input=${opening.id}`);
    const newConversation = 'b97f3e4c-de96-4fc4-ada0-123456789abc';
    dom.window.document.querySelector('textarea')!.addEventListener('keydown', event => {
      if (event.key === 'Enter') dom.window.history.pushState({}, '', `/a/chat/s/${newConversation}`);
    });
    driver = pageDriver(); driver.start();
    await wait(async () => expect((await listInputs()).find(input => input.id === opening.id)?.state).toBe('sent'));
    expect(typed).toEqual([expect.stringContaining('Start this exact task')]);
    expect((await getSession(opening.sessionId!))?.conversationId).toBe(newConversation);
  } finally { stray.stop(); strayPage.window.close(); }
});

it('executes a real shell command, automatically delivers its result, reads the created file and completes one local turn', async () => {
  const sourceTurn = (await getSession(sessionId))!.activeTurnId;
  replies.push(tools([{ id: 'verify', name: 'read', arguments: { paths: [path.join(directory, 'counter.txt')] } }]), 'RUNTIME_COMPLETE');
  respond(tools([command('node -e "const fs=require(\'node:fs\');fs.appendFileSync(\'counter.txt\',\'one\\n\');fs.writeSync(1,\'SHELL_OK\\n\')"')]));
  await wait(async () => expect((await getSession(sessionId))?.lastTurnOutcome).toBe('completed'));
  expect(await fs.readFile(path.join(directory, 'counter.txt'), 'utf8')).toBe('one\n');
  const events = await readEvents(sessionId);
  const calls = events.filter(event => event.kind === 'tool_call');
  expect(calls.map(event => [event.call.tool, event.call.outcome])).toEqual([['exec_command', 'ok'], ['read', 'ok']]);
  expect(typed).toHaveLength(2);
  expect(typed[0]).toContain('SHELL_OK'); expect(typed[1]).toContain('one');
  expect(events.filter(event => event.kind === 'turn_start')).toHaveLength(1);
  expect(events.filter(event => event.kind === 'turn_end')).toEqual([expect.objectContaining({ turnId: sourceTurn, outcome: 'completed' })]);
  expect(transcriptEntries(events).filter(event => event.role === 'user').map(event => event.stored.text)).toEqual(['Execute the task and verify it.']);
  expect((await listInputs()).every(input => input.state === 'sent')).toBe(true);
});

it('carries the actual Stop command to the native page and records stopped without executing its partial proposal', async () => {
  const sourceTurn = (await getSession(sessionId))!.activeTurnId!;
  respond(tools([command('node -e "require(\'node:fs\').writeFileSync(\'must-not-exist\',\'bad\')"')]), true);
  await stopSessionTurn(sessionId, sourceTurn);
  await wait(async () => expect((await getSession(sessionId))?.lastTurnOutcome).toBe('stopped'));
  expect(dom.window.document.getElementById('native-stop')).toBeNull();
  expect(await fs.access(path.join(directory, 'must-not-exist')).then(() => true, () => false)).toBe(false);
  expect((await readEvents(sessionId)).filter(event => event.kind === 'tool_call')).toEqual([]);
  expect(typed).toEqual([]);
  expect((await sessionControlsFor(sessionId)).stopPending).toBe(false);
});

it('restores a queued real-tool result from disk and continues without running the command again', async () => {
  const sourceTurn = (await getSession(sessionId))!.activeTurnId;
  suspendOnQueuedResults = true;
  respond(tools([command('node -e "require(\'node:fs\').appendFileSync(\'counter.txt\',\'one\\n\')"')]));
  await wait(async () => expect((await listInputs()).some(input => input.state === 'queued')).toBe(true));
  expect(typed).toEqual([]);
  await flushRecorder(); await flushSessions(); await flushDurable();
  resetBridgeForTests(); resetRecorderForTests(); resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests();
  initSessionStore(directory); initDurableStore(directory);
  expect((await getSession(sessionId))?.activeTurnId).toBe(sourceTurn);
  expect((await listInputs())[0]).toMatchObject({ state: 'queued', deepSeekContinuation: { turnId: sourceTurn } });
  suspendOnQueuedResults = false;
  replies.push('RESTORED_COMPLETE');
  driver = pageDriver(); driver.start();
  await wait(async () => expect((await getSession(sessionId))?.lastTurnOutcome).toBe('completed'));
  expect(await fs.readFile(path.join(directory, 'counter.txt'), 'utf8')).toBe('one\n');
  expect((await readEvents(sessionId)).filter(event => event.kind === 'tool_call')).toHaveLength(1);
  expect(typed).toHaveLength(1);
  expect((await listInputs()).every(input => input.state === 'sent')).toBe(true);
});

it('stops a real tool batch while the first process runs and never launches the next call or sends its late output', async () => {
  const sourceTurn = (await getSession(sessionId))!.activeTurnId!;
  const script = "const fs=require('node:fs');fs.writeFileSync('started','yes');const t=setInterval(()=>{if(fs.existsSync('release')){clearInterval(t);console.log('late output')}},20)";
  respond(tools([command(`node -e "${script}"`), { id: 'must-not-run', name: 'read', arguments: { paths: [directory] } }]));
  await wait(async () => expect(await fs.access(path.join(directory, 'started')).then(() => true, () => false)).toBe(true));
  await stopSessionTurn(sessionId, sourceTurn);
  await wait(async () => expect((await getSession(sessionId))?.lastTurnOutcome).toBe('stopped'));
  await fs.writeFile(path.join(directory, 'release'), 'yes');
  await wait(async () => expect((await readEvents(sessionId)).filter(event => event.kind === 'tool_call')).toHaveLength(1));
  expect((await readEvents(sessionId)).filter(event => event.kind === 'tool_call').map(event => event.call.tool)).toEqual(['exec_command']);
  expect(await listInputs()).toEqual([]);
  expect(typed).toEqual([]);
});
