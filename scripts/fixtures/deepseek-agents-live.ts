/**
 * Live smoke: a real DeepSeek page carries a worker bootstrap, its report and its finish.
 *
 * Run by `scripts/verify-deepseek-agents-live.mjs` with a signed-in built-in browser. The app
 * opens the worker's own DeepSeek chat, the page driver types the bootstrap, the model answers
 * with the text tool protocol, and the app executes `agents` calls through the kernel. A wake
 * then goes back into the same chat and the worker reports a second time.
 *
 * Nothing here fakes the page, the bridge or the tool host. The only substitutions are the
 * prime conversation (this fixture starts a run directly instead of talking through an MCP
 * client) and the worker prompt, which asks for the exact envelopes the smoke needs.
 */
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  ackWorkerCommandForApp,
  claimPendingWorkerRevivalForApp,
  claimWorkerCommandForApp,
  failWorkerRevivalForApp,
  setBrowserOpener,
  shutdownBridge,
  startBridge
} from '../../src/main/bridge.js';
import { attachDeepSeekPageDriver, setDeepSeekWorkerBridge } from '../../src/main/deepseek/page-driver.js';
import { deepSeekConversationId } from '../../src/main/deepseek/site.js';
import { flushLogFile, initLogFile } from '../../src/main/logger.js';
import { CosBrowser } from '../../src/main/cos-browser/host.js';
import { defaultConfig, initConfigPath, loadConfig, saveConfig } from '../../src/main/config.js';
import { initSecretsPath } from '../../src/main/secrets.js';
import { initSessionStore } from '../../src/main/session/store.js';
import { flushDurable, initDurableStore, writeDurableNow } from '../../src/main/durable.js';
import { pageDiagnostics, prepareSignedInPage } from './deepseek-live-auth.js';
import {
  offerMessagesForCaller,
  onSwarmPersistNow,
  pendingWorkerSpawns,
  requestWorkerBootstraps,
  requestWorkerRevivals,
  spawn,
  stageMessages,
  swarmState
} from '../../src/main/agents.js';

const run = process.argv[2];
if (!run) throw new Error('missing run directory');
// The launcher names a throwaway directory holding the copied browser sign-in. Falling back to
// run/runtime keeps a direct `electron fixture.cjs <run>` invocation working for a manual probe.
app.setPath('userData', process.argv[3] ?? path.join(run, 'runtime'));
app.disableHardwareAcceleration();

const report: {
  checks: string[];
  workerConversation?: string;
  pages?: unknown[];
  worker?: unknown;
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

const PRIME = `live-smoke-prime-${Date.now()}`;
const PROMPT = [
  'You are worker-1 in a live Chat On Steroids smoke test. Your whole job is two tool reports.',
  'Answer with exactly one JSON object and nothing else — no prose and no code fence.',
  'First answer:',
  '{"type":"tool_calls","calls":[{"id":"report-1","name":"agents","arguments":{"action":"message","to":"prime","text":"live worker reached the page"}}]}',
  'After the app sends you the tool result, answer with exactly:',
  '{"type":"tool_calls","calls":[{"id":"finish-1","name":"agents","arguments":{"action":"finish","result":"live smoke complete"}}]}'
].join('\n');
const WAKE = [
  'Wake up for one more live check.',
  'Answer with exactly one JSON object and nothing else — no prose and no code fence.',
  'First answer:',
  '{"type":"tool_calls","calls":[{"id":"report-2","name":"agents","arguments":{"action":"message","to":"prime","text":"live worker woke up"}}]}',
  'After the app sends you the tool result, answer with exactly:',
  '{"type":"tool_calls","calls":[{"id":"finish-2","name":"agents","arguments":{"action":"finish","result":"live wake complete"}}]}'
].join('\n');

function worker() {
  const state = swarmState();
  // A finished worker parks its whole family into retained history; it is still the same
  // sleeping worker and must be found there before a wake.
  return state.agents.find(agent => agent.id === 'worker-1') ??
    state.retainedWorkers?.find(agent => agent.id === 'worker-1');
}

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
    initLogFile(path.join(run, 'app.log'));
    report.log = path.join(run, 'app.log');
    await loadConfig();
    const base = defaultConfig();
    await saveConfig({
      ...base,
      ui: { ...base.ui, chatBrowser: 'cos', backgroundChats: true, keepAwake: false, turnNotifications: false },
      multiAgent: { ...base.multiAgent, enabled: true, archiveWorkerChats: false, allowUnattributedCalls: true }
    });
    onSwarmPersistNow(snapshot => writeDurableNow('swarm', snapshot));

    setBrowserOpener(async (url: string) => {
      assert.ok(url.startsWith('https://chat.deepseek.com'), `unexpected app-owned URL ${url}`);
      const conversation = deepSeekConversationId(url);
      const marker = /[?&#]clf=([^&#]+)/.exec(url)?.[1];
      await browser.ensureBackground(
        url,
        conversation ? { conversationId: conversation } : marker ? { marker: `clf=${marker}` } : {}
      );
    });
    // The exact production wiring from src/main/index.ts.
    setDeepSeekWorkerBridge({
      claim: claimWorkerCommandForApp,
      ack: ackWorkerCommandForApp,
      claimPendingRevival: claimPendingWorkerRevivalForApp,
      failRevival: failWorkerRevivalForApp
    });

    const port = await startBridge();
    assert.ok(port, 'the bridge did not start');
    // Make the copied profile prove its session before a worker waits out its whole bootstrap
    // window on a sign-in screen. A missing or expired login is the harness's problem, not the
    // worker's, and it should be named as such.
    const bootstrapWaitMs = Number(process.env.COS_DEEPSEEK_BOOTSTRAP_WAIT_MS) || 180_000;
    const signed = await prepareSignedInPage(browser, null);
    report.checks.push('production bridge and built-in DeepSeek browser started; the page is signed in');
    report.pages = signed;
    console.log('DeepSeek pages before the worker:', JSON.stringify(report.pages, null, 2));

    const created = spawn({ workers: [{ task: PROMPT, label: 'Live smoke' }], caller: { conversationId: PRIME } });
    requestWorkerBootstraps(created.created.map(agent => agent.id), created.runId);
    const active = await until(() => {
      const current = worker();
      return current && current.state === 'active' && current.conversationId ? current : null;
    }, 'worker bootstrap on the real page', bootstrapWaitMs);
    const conversationId = active!.conversationId!;
    report.workerConversation = conversationId;
    report.checks.push(`spawn: worker-1 bound to real DeepSeek chat ${conversationId}`);

    await until(() => offerMessagesForCaller({ conversationId: PRIME })?.messages.some(message =>
      message.from === 'worker-1' && message.text.includes('live worker reached the page')), 'worker report');
    report.checks.push('report: agents message reached the prime inbox');
    await until(() => worker()?.state === 'sleeping', 'worker finish');
    report.checks.push('finish: agents finish put the same worker back to sleeping');

    const staged = stageMessages({ conversationId: PRIME }, [{ to: 'worker-1', text: WAKE }]);
    staged.commit();
    assert.ok(staged.waking.length > 0, 'the staged wake reserved no worker');
    requestWorkerRevivals(staged.waking);
    await until(() => worker()?.state === 'waking', 'app-owned wake claim');
    report.checks.push('wake: the app page claimed the sleeping worker wake by its conversation');
    await until(() => offerMessagesForCaller({ conversationId: PRIME })?.messages.some(message =>
      message.from === 'worker-1' && message.text.includes('live worker woke up')), 'second worker report');
    report.checks.push('wake report: the second agents message reached the prime inbox');
    await until(() => worker()?.state === 'sleeping', 'second worker finish');
    report.checks.push('wake finish: the second agents finish put the worker back to sleeping');

    await fs.writeFile(path.join(run, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ run, ...report }, null, 2));
    exitCode = 0;
  } catch (error) {
    exitCode = 1;
    report.error = error instanceof Error ? error.stack : String(error);
    report.pages = await pageDiagnostics(browser).catch(() => []);
    report.worker = worker() ?? null;
    console.error('DeepSeek pages at failure:', JSON.stringify(report.pages, null, 2));
    await flushLogFile().catch(() => {});
    await fs.writeFile(path.join(run, 'failure.json'), JSON.stringify(report, null, 2));
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    setDeepSeekWorkerBridge(null);
    await shutdownBridge();
    browser.stop();
    await flushDurable();
    await flushLogFile().catch(() => {});
    console.error(`DeepSeek live fixture exiting with ${exitCode}`);
    process.exitCode = exitCode;
    app.exit(exitCode);
  }
});
