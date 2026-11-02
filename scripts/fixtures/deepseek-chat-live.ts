/**
 * Live smoke: one ordinary DeepSeek chat send, its streaming answer, a real tool call and the
 * continuation that follows it.
 *
 * Run by `scripts/verify-deepseek-chat-live.mjs` with a signed-in built-in browser. The app's own
 * outbox creates a new chat, the page driver types the framed first message, the model asks for
 * `update_plan`, the app runs it and queues the tool result, and the model answers the continuation.
 *
 * The only harness substitution is the app window: this fixture calls the same input and page
 * owners directly instead of driving the renderer. The outbox, prompt frame, page driver, tool
 * kernel, recorder and reply path are the production ones.
 */
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { attachDeepSeekPageDriver } from '../../src/main/deepseek/page-driver.js';
import { deepSeekOpeningUrl } from '../../src/main/deepseek/browser.js';
import { describeDeepSeekTools } from '../../src/main/deepseek/tool-host.js';
import { buildDeepSeekToolInstructions } from '../../src/main/deepseek/tool-protocol.js';
import { draftTaskPlan } from '../../src/main/goal.js';
import { CosBrowser } from '../../src/main/cos-browser/host.js';
import { defaultConfig, initConfigPath, loadConfig, saveConfig } from '../../src/main/config.js';
import { initSecretsPath } from '../../src/main/secrets.js';
import { initSkillsPath } from '../../src/main/skills.js';
import { initDurableStore, flushDurable } from '../../src/main/durable.js';
import { getSession, initSessionStore, readRecentEvents } from '../../src/main/session/store.js';
import { configureInputDelivery, enqueueInput, listInputs } from '../../src/main/session/input.js';
import { prepareSessionPrompt } from '../../src/main/session/prompt.js';
import { flushLogFile, initLogFile } from '../../src/main/logger.js';
import { pageDiagnostics, prepareSignedInPage } from './deepseek-live-auth.js';

const run = process.argv[2];
if (!run) throw new Error('missing run directory');
app.setPath('userData', process.argv[3] ?? path.join(run, 'runtime'));
app.disableHardwareAcceleration();

const report: {
  checks: string[];
  inputId?: string;
  sessionId?: string;
  conversationId?: string;
  streamingMessageId?: string;
  pages?: unknown[];
  log?: string;
  error?: string;
} = { checks: [] };

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, label: string, timeout = 180_000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(500);
  }
  throw new Error(`${label}: ${last instanceof Error ? last.message : 'timed out'}`);
}

const TASK = [
  'This is a live Chat On Steroids smoke test. Do not explain.',
  'First answer with exactly one JSON object and nothing else:',
  '{"type":"tool_calls","calls":[{"id":"plan-1","name":"update_plan","arguments":{"explanation":"live smoke","plan":[{"step":"Exercise the ordinary DeepSeek chat","status":"in_progress"}]}}]}',
  'After the app sends you the tool result, answer with one short sentence that starts exactly:',
  'CONTINUATION_OK'
].join('\n');

app.on('web-contents-created', (_event, contents) => {
  // The production app installs the same driver for every document; it is inert outside
  // chat.deepseek.com.
  attachDeepSeekPageDriver(contents);
});

void app.whenReady().then(async () => {
  let exitCode = 1;
  const browser = new CosBrowser({
    preloadDir: path.resolve('out/preload'),
    rendererDir: path.resolve('out/renderer'),
    rendererUrl: () => null
  });
  try {
    const data = app.getPath('userData');
    initConfigPath(data);
    initSecretsPath(data);
    initSessionStore(data);
    initDurableStore(data);
    initSkillsPath(data);
    initLogFile(path.join(run, 'app.log'));
    report.log = path.join(run, 'app.log');
    await loadConfig();
    const base = defaultConfig();
    await saveConfig({
      ...base,
      ui: { ...base.ui, chatBrowser: 'cos', backgroundChats: true, keepAwake: false, turnNotifications: false },
      multiAgent: { ...base.multiAgent, enabled: false, archiveWorkerChats: false, allowUnattributedCalls: true }
    });
    configureInputDelivery({
      prepareText: async (entry, limits, authored) => {
        // Only the first message of a new executor chat carries the Core instructions and the
        // DeepSeek text tool protocol; the continuation is plain tool-result text.
        if (((entry.opening || !entry.sessionId) && !entry.conversationId && !entry.finishOwner && entry.mode !== 'finish')) {
          return prepareSessionPrompt(entry.text, entry, limits, authored,
            buildDeepSeekToolInstructions(describeDeepSeekTools()));
        }
        return entry.text;
      }
    });

    const signed = await prepareSignedInPage(browser, null);
    report.pages = signed;
    report.checks.push('the built-in DeepSeek browser is signed in');

    // Exercise the production hidden helper as well as the ordinary executor. Mock helper
    // pages cannot prove that a real invisible Chromium page mounts DeepSeek's composer.
    const stages = await draftTaskPlan('Plan a tiny local greeting program and a separate verification stage. Do not execute it.', 'chatgpt');
    assert.ok(stages.length >= 2 && stages.length <= 12, 'the live helper returned no valid workflow');
    report.checks.push('planner: a real hidden DeepSeek helper returned a validated staged workflow');

    const id = randomUUID();
    report.inputId = id;
    const row = await enqueueInput({ id, sessionId: null, text: TASK, mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null });
    assert.equal(row.conversationId, null, 'a new-chat opening must start without a conversation');
    const sessionId = row.sessionId!;
    report.sessionId = sessionId;
    await browser.ensureBackground(deepSeekOpeningUrl(id), { marker: `cos-input=${encodeURIComponent(id)}` });

    const sent = await until(async () => {
      const current = (await listInputs()).find(entry => entry.id === id);
      return current?.state === 'sent' && current.conversationId ? current : null;
    }, 'ordinary opening receipt');
    const conversationId = sent.conversationId!;
    report.conversationId = conversationId;
    const session = await getSession(sessionId);
    assert.equal(session?.conversationId, conversationId);
    report.checks.push(`send: the app sent the first message into real DeepSeek chat ${conversationId}`);

    const tool = await until(async () => {
      const events = await readRecentEvents(sessionId, 100, { kinds: ['tool_call'] });
      return events.find(event => event.kind === 'tool_call' && event.call.tool === 'update_plan' && event.call.outcome === 'ok') ?? null;
    }, 'update_plan tool result');
    report.checks.push('tool: the model requested update_plan and the app ran it');

    const continuation = await until(async () => {
      const rows = await listInputs();
      return rows.find(entry => entry.sessionId === sessionId && entry.id !== id &&
        entry.text.includes('"type":"tool_results"') && (entry.state === 'sent' || entry.state === 'browser')) ?? null;
    }, 'tool-result continuation delivery');
    report.checks.push('continuation: the app queued and delivered the tool results');

    const streamingIds = new Set<string>();
    const final = await until(async () => {
      const events = await readRecentEvents(sessionId, 100, { kinds: ['assistant_message'] });
      for (const event of events) {
        if (event.kind === 'assistant_message' && event.state === 'streaming') streamingIds.add(event.messageId);
      }
      return events.find(event => event.kind === 'assistant_message' && event.state === 'final' &&
        event.message.text.includes('CONTINUATION_OK')) ?? null;
    }, 'ordinary continuation final');
    report.streamingMessageId = [...streamingIds][0];
    report.checks.push('stream: the page recorded a live answer revision before it settled');
    report.checks.push(`finish: the continuation answered ${JSON.stringify(final.message.text.slice(0, 80))}`);

    const settled = (await readRecentEvents(sessionId, 100, { kinds: ['assistant_message'] }))
      .find(event => event.kind === 'assistant_message' && event.state === 'final' && streamingIds.has(event.messageId));
    assert.ok(settled, 'no streaming revision kept its identity after the answer settled');
    report.checks.push('identity: a streamed answer kept one message id after it settled');

    await fs.writeFile(path.join(run, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ run, ...report }, null, 2));
    exitCode = 0;
  } catch (error) {
    exitCode = 1;
    report.error = error instanceof Error ? error.stack : String(error);
    report.pages = await pageDiagnostics(browser).catch(() => []);
    console.error('DeepSeek pages at failure:', JSON.stringify(report.pages, null, 2));
    await flushLogFile().catch(() => {});
    await fs.writeFile(path.join(run, 'failure.json'), JSON.stringify(report, null, 2));
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    browser.stop();
    await flushDurable();
    await flushLogFile().catch(() => {});
    console.error(`DeepSeek ordinary live fixture exiting with ${exitCode}`);
    process.exitCode = exitCode;
    app.exit(exitCode);
  }
});
