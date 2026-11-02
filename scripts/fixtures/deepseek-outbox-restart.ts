/**
 * Restart smoke for the outbox's delivered-receipt settlement.
 *
 * Run three times against the same user-data folder by `verify-deepseek-outbox-restart.mjs`:
 *
 *   seed   writes a failed row that carries a message id and delivery time, then exits. A second
 *          failed row has a message id but no delivery time, so the settlement must leave it alone.
 *   first  a fresh Electron process starts with that outbox on disk and loads it. The delivered
 *          row must become sent with its exact receipt, and no browser work may be prepared.
 *   second the restart process must find the same receipt, still without a browser or a resend.
 *
 * This uses the production store, durable writer and outbox owner in a real Electron process. It
 * deliberately does not start the app window or the built-in browser: Setup's sign-in probe opens
 * its own DeepSeek page at startup, so a page count in the full app could not tell whether the
 * outbox itself opened one.
 */
import { app, webContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initConfigPath, loadConfig } from '../../src/main/config.js';
import { initDurableStore, writeDurableNow, flushDurable } from '../../src/main/durable.js';
import { createSession, initSessionStore, readRecentEvents } from '../../src/main/session/store.js';
import { claimBrowserInput, configureInputDelivery, listInputs, pendingBrowserInputs, type InputEntry } from '../../src/main/session/input.js';
import { flushLogFile, initLogFile } from '../../src/main/logger.js';

const run = process.argv[2];
const runtime = process.argv[3];
const phase = process.argv[4];
if (!run || !runtime || (phase !== 'seed' && phase !== 'first' && phase !== 'second')) {
  throw new Error('usage: deepseek-outbox-restart <run-dir> <user-data-dir> <seed|first|second>');
}
app.setPath('userData', runtime);
app.disableHardwareAcceleration();

const DELIVERED_TEXT = 'restart-smoke-delivered';
const UNPROVEN_TEXT = 'restart-smoke-unproven';
const DELIVERED_ERROR = 'Message sent, but automation was not confirmed. Check its chat settings.';
const AUTOMATION_NOTE = 'This message was sent, but its Goal/Loop change was not confirmed. Check the chat settings before relying on its mode.';
const UNPROVEN_ERROR = 'Automation was not confirmed; this message was not sent. Send again to retry.';
const STATE = path.join(runtime, 'state', 'session-input.json');

const report: {
  phase: string;
  ok?: boolean;
  checks: string[];
  rows?: { delivered: string; undelivered: string; sessionId: string };
  before?: { delivered: string; undelivered: string };
  after?: { delivered: string; undelivered: string };
  webContentsCreated?: number;
  webContentsOpen?: number;
  pendingBrowserInputs?: number;
  error?: string;
} = { phase, checks: [] };
let createdContents = 0;
app.on('web-contents-created', () => { createdContents += 1; });

async function rowsOnDisk(): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await fs.readFile(STATE, 'utf8')) as Array<Record<string, unknown>>;
}
function rowByText(rows: Array<Record<string, unknown>>, text: string): Record<string, unknown> {
  const row = rows.find(entry => entry.text === text);
  assert.ok(row, `seeded row ${text} is missing`);
  return row;
}
function stateOf(row: Record<string, unknown> | undefined): string {
  return typeof row?.state === 'string' ? row.state : '(missing)';
}

void app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    initConfigPath(runtime);
    initSessionStore(runtime);
    initDurableStore(runtime);
    initLogFile(path.join(run, `app-${phase}.log`));
    await loadConfig();

    if (phase === 'seed') {
      const conversationId = randomUUID();
      const session = await createSession({ title: 'Outbox restart smoke', conversationId });
      const at = Date.now() - 60_000;
      const deliveredAt = at + 1_500;
      const delivered: InputEntry = {
        id: randomUUID(),
        sessionId: session.id,
        deliveredSessionId: session.id,
        conversationId,
        text: DELIVERED_TEXT,
        purpose: 'user',
        automation: 'off',
        mode: 'auto',
        dueAt: at,
        model: null,
        reasoningEffort: null,
        state: 'failed',
        owner: null,
        createdAt: at,
        messageId: `ds:${conversationId}:user:row--2`,
        deliveredAt,
        error: DELIVERED_ERROR,
        historyRecorded: true,
        historyAnchored: true
      };
      const undelivered: InputEntry = {
        id: randomUUID(),
        sessionId: session.id,
        deliveredSessionId: session.id,
        conversationId,
        text: UNPROVEN_TEXT,
        purpose: 'user',
        automation: 'off',
        mode: 'auto',
        dueAt: at,
        model: null,
        reasoningEffort: null,
        state: 'failed',
        owner: null,
        createdAt: at + 1,
        // A page may have received it, but no receipt proves that; it must stay failed.
        messageId: `ds:${conversationId}:user:row--4`,
        error: UNPROVEN_ERROR
      };
      await writeDurableNow('session-input', [delivered, undelivered]);
      const onDisk = await rowsOnDisk();
      assert.equal(stateOf(rowByText(onDisk, DELIVERED_TEXT)), 'failed');
      assert.equal(stateOf(rowByText(onDisk, UNPROVEN_TEXT)), 'failed');
      report.rows = { delivered: delivered.id, undelivered: undelivered.id, sessionId: session.id };
      report.checks.push('seeded a failed row with a receipt and a failed row without one');
    } else {
      configureInputDelivery({
        // Startup must not apply a pending automation write for a row whose delivery is already
        // proven. A call here would be a re-send side effect, not settlement.
        applyAutomation: async () => { throw new Error('startup settlement applied automation'); },
        changed: () => undefined,
        // The seeded receipt is already recorded; keep the hook inert if a future load asks.
        recordDelivered: async () => false
      });

      const before = await rowsOnDisk();
      const priorDelivered = rowByText(before, DELIVERED_TEXT);
      const priorUndelivered = rowByText(before, UNPROVEN_TEXT);
      const deliveredId = String(priorDelivered.id);
      const undeliveredId = String(priorUndelivered.id);
      const deliveredAt = Number(priorDelivered.deliveredAt);
      assert.ok(Number.isFinite(deliveredAt), 'the seeded delivery receipt is missing');
      assert.equal(typeof priorDelivered.messageId, 'string', 'the seeded message id is missing');
      const deliveredMessageId = priorDelivered.messageId;
      assert.ok(deliveredMessageId.length > 0, 'the seeded message id is empty');
      assert.equal(stateOf(priorDelivered), phase === 'first' ? 'failed' : 'sent');
      assert.equal(stateOf(priorUndelivered), 'failed');
      assert.equal(priorUndelivered.deliveredAt, undefined);
      report.before = { delivered: stateOf(priorDelivered), undelivered: stateOf(priorUndelivered) };
      report.checks.push(phase === 'first'
        ? 'the first startup load found the seeded row failed'
        : 'the restart found the delivered row already settled');

      // This is the production startup read: settle the receipt, then publish/materialize without
      // any browser being started.
      const rows = await listInputs();
      const delivered = rows.find(row => row.id === deliveredId);
      const undelivered = rows.find(row => row.id === undeliveredId);
      assert.ok(delivered, 'the delivered row disappeared from the outbox');
      assert.ok(undelivered, 'the unproven row disappeared from the outbox');
      assert.equal(delivered.state, 'sent');
      // The switch write is never replayed; its exact warning remains the durable tombstone.
      assert.equal(delivered.error, DELIVERED_ERROR);
      assert.equal(delivered.automation, 'off');
      assert.equal(delivered.messageId, deliveredMessageId);
      assert.equal(delivered.deliveredAt, deliveredAt);
      assert.equal(delivered.historyRecorded, true);
      assert.equal(delivered.sendAuthorizedAt, undefined);
      assert.equal(delivered.offeredAt, undefined);
      assert.equal(undelivered.state, 'failed');
      assert.equal(undelivered.error, UNPROVEN_ERROR);
      assert.equal(undelivered.deliveredAt, undefined);
      const noteSession = priorDelivered.sessionId ?? priorDelivered.deliveredSessionId;
      assert.equal(typeof noteSession, 'string', 'the delivered row has no session for its note');
      const notes = await readRecentEvents(noteSession, 20, { kinds: ['note'] });
      assert.equal(notes.filter(event => event.kind === 'note' && event.message.text === AUTOMATION_NOTE).length, 1,
        'the unconfirmed automation has no single durable timeline note');
      report.after = { delivered: delivered.state, undelivered: undelivered.state };
      report.checks.push('the delivered row settled to sent, kept its exact receipt and automation warning');
      report.checks.push('exactly one durable timeline note records the unconfirmed automation');
      report.checks.push('the failed row without a delivery time stayed failed');

      const pending = await pendingBrowserInputs();
      assert.deepEqual(pending, []);
      assert.equal(await claimBrowserInput(deliveredId, 'restart-smoke', delivered.conversationId, true), null);
      report.pendingBrowserInputs = pending.length;
      report.checks.push('no browser input was pending or claimable');

      const onDisk = await rowsOnDisk();
      assert.equal(stateOf(onDisk.find(row => row.id === deliveredId)), 'sent');
      assert.equal(stateOf(onDisk.find(row => row.id === undeliveredId)), 'failed');

      report.webContentsCreated = createdContents;
      report.webContentsOpen = webContents.getAllWebContents().length;
      assert.equal(createdContents, 0, 'the outbox load opened a web contents');
      assert.equal(report.webContentsOpen, 0, 'the outbox load left a web page open');
      report.checks.push('the outbox load opened no browser page');
    }

    report.ok = true;
    exitCode = 0;
    console.log(`outbox restart smoke (${phase}): ${report.checks.join('; ')}`);
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`outbox restart smoke (${phase}) failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await fs.writeFile(path.join(run, `${phase}.json`), JSON.stringify(report, null, 2), 'utf8').catch(() => undefined);
    await flushDurable().catch(() => undefined);
    await flushLogFile().catch(() => undefined);
    app.exit(exitCode);
  }
});
