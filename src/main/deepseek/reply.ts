/**
 * One DeepSeek model reply, from transcript to tool results.
 *
 * A page reports an answer; this records it, runs any tools the answer asked for, and files the
 * one continuation that carries the results back. The bridge route and the in-app page driver
 * both call this, so DeepSeek has exactly one path through history and the tool kernel no
 * matter whether a reply arrived over HTTP or was read off the page.
 */

import { createHash } from 'node:crypto';
import { logWarn } from '../logger.js';
import { isChatBlocked } from '../session/blocked-chats.js';
import { enqueueInput, listInputs } from '../session/input.js';
import { recordChatObservations } from '../session/recorder.js';
import { conversationWasSuperseded, getSession } from '../session/store.js';
import { advanceDeepSeekGoal } from './goal.js';
import { createDeepSeekToolHost, deepSeekToolResultText } from './tool-host.js';
import { runDeepSeekTurn, type DeepSeekCompletedCall } from './turn.js';
import { parseDeepSeekReply, type DeepSeekToolDescriptor } from './tool-protocol.js';

/** Replies whose tools are still running; a retry must wait, never run them twice. */
const turnsInFlight = new Set<string>();
/**
 * One reply's execution and results until the outbox accepts them. Source identity and each
 * accepted call survive a transient read/write failure; no retry may execute that call again.
 */
interface PendingReply {
  sessionId: string;
  turnId: string;
  text: string;
  tools: readonly DeepSeekToolDescriptor[];
  completedCalls: Map<string, DeepSeekCompletedCall>;
  continuation?: string;
}
const pendingReplies = new Map<string, PendingReply>();
/** Bounded: one per reply still waiting on a retry, never a growing history. */
const MAX_UNQUEUED = 64;

/**
 * The swarm's seam for a tool-free answer. The bridge owns worker state; it installs this at
 * startup, and tests inject a fake. 'worker' ends the reply path: a worker's answer is its
 * report, and no Goal or Loop step is ever typed into a worker's chat.
 */
export type DeepSeekWorkerFinish = (conversationId: string, text: string) => Promise<'worker' | 'not-worker' | 'not-durable'>;
let finishWorker: DeepSeekWorkerFinish | null = null;
/** The bridge's existing durable Stop commands own this veto; no second stop ledger. */
let stopRequested: (conversationId: string, turnId?: string) => boolean = () => false;
export function setDeepSeekReplyStopCheck(check: typeof stopRequested): void { stopRequested = check; }

export function setDeepSeekWorkerFinish(finish: DeepSeekWorkerFinish | null): void {
  finishWorker = finish;
}

export interface DeepSeekReplyInput {
  conversationId: string;
  text: string;
  /** Stable provider-side identity of this answer; makes re-reporting it idempotent. */
  messageId: string;
  /** Page fallback text is flattened; HTTP/provider fragments are Markdown by default. */
  textFormat?: 'plain' | 'markdown';
  turnId?: string;
  /** A streaming page may report revisions; only the final one is transcript content. */
  final?: boolean;
}

export type DeepSeekReplyResult =
  | { status: 200; body: { ok: true; [key: string]: unknown } }
  | { status: 202; body: { ok: true; status: 'running' } }
  | { status: 409; body: { error: 'unknown_conversation' | 'chat_blocked' | 'chat_superseded' | 'reply_identity_changed' } }
  | { status: 503; body: { error: 'reply_not_durable' | 'results_not_queued' | 'worker_state_not_durable'; retryable: true } };

export async function deliverDeepSeekReply(input: DeepSeekReplyInput): Promise<DeepSeekReplyResult> {
  const { conversationId, text, messageId, turnId } = input;
  if (input.final === false) return { status: 200, body: { ok: true, status: 'answer', deferred: true } };
  const intermediate = parseDeepSeekReply(text, new Set()).kind !== 'text';

  // History first: the answer is transcript content whether or not it asks for tools. The
  // recorder is the same owner every page observation goes through, so it is deduplicated by
  // message id and stays readable even while the chat is blocked.
  let sessionId: string | null;
  try {
    sessionId = (await recordChatObservations(conversationId, [{
      kind: 'assistant_message',
      time: Date.now(),
      text,
      textFormat: input.textFormat ?? 'markdown',
      messageId,
      final: !intermediate,
      state: intermediate ? 'streaming' : 'final',
      providerRole: 'assistant',
      providerStatus: intermediate ? 'in_progress' : 'finished_successfully',
      ...(turnId ? { turnId } : {})
    }])).sessionId;
  } catch (err) {
    logWarn(`deepseek: reply for ${conversationId} was not recorded — ${err instanceof Error ? err.message : String(err)}`);
    return { status: 503, body: { error: 'reply_not_durable', retryable: true } };
  }
  if (!sessionId) return { status: 409, body: { error: 'unknown_conversation' } };
  if (isChatBlocked(conversationId) || await conversationWasSuperseded(conversationId)) {
    return { status: 409, body: { error: isChatBlocked(conversationId) ? 'chat_blocked' : 'chat_superseded' } };
  }
  // One model reply owns one tool turn. The outbox row is keyed by that reply, not by the
  // results, so a page that retries after a lost response neither runs the tools again nor
  // types the same results into the chat twice.
  const digest = createHash('sha256').update(`deepseek:${conversationId}:${messageId}`, 'utf8').digest('hex');
  const inputId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  if ((await listInputs()).some(entry => entry.id === inputId)) {
    pendingReplies.delete(inputId);
    return { status: 200, body: { ok: true, status: 'duplicate', queued: inputId } };
  }

  let pending = pendingReplies.get(inputId);
  if (pending && (pending.sessionId !== sessionId || pending.text !== text || (turnId && pending.turnId !== turnId)))
    return { status: 409, body: { error: 'reply_identity_changed' } };
  // An omitted turn may reuse this reply's already-proven owner. It can never borrow
  // whichever unrelated turn happens to be active when an old message is reported again.
  const sourceTurnId = pending?.turnId ?? turnId;
  const current = async (): Promise<boolean> => {
    if (stopRequested(conversationId, sourceTurnId) || isChatBlocked(conversationId) || await conversationWasSuperseded(conversationId)) return false;
    const session = await getSession(sessionId!);
    return !!sourceTurnId && session?.conversationId === conversationId && session.activeTurnId === sourceTurnId &&
      !(session.finishTurn?.turnId === sourceTurnId && session.finishTurn.released);
  };

  // A tool turn can outlive the page's fetch timeout. A retry that arrives while this exact
  // reply is still running must wait, not run its tools a second time; the outbox row above
  // covers every retry that arrives after it finishes.
  if (turnsInFlight.has(inputId)) return { status: 202, body: { ok: true, status: 'running' } };
  turnsInFlight.add(inputId);
  // A re-delivered continuation reports only that it was queued: its tools ran on an earlier try.
  let summary: Record<string, unknown> = { status: 'requeued' };
  try {
    if (intermediate && !await current()) {
      pendingReplies.delete(inputId);
      return { status: 200, body: { ok: true, status: 'stopped' } };
    }
    // Never evict an accepted result to admit another tool reply. Backpressure happens
    // before execution, while retries of the admitted replies can still make progress.
    if (intermediate && !pending && pendingReplies.size >= MAX_UNQUEUED) {
      for (const [id, retained] of [...pendingReplies]) {
        const owner = await getSession(retained.sessionId);
        if (pendingReplies.get(id) === retained && (!owner || owner.activeTurnId !== retained.turnId ||
            (owner.finishTurn?.turnId === retained.turnId && owner.finishTurn.released))) pendingReplies.delete(id);
      }
      if (pendingReplies.size >= MAX_UNQUEUED)
        return { status: 503, body: { error: 'results_not_queued', retryable: true } };
    }
    let continuation = pending?.continuation;
    if (continuation === undefined) {
      const host = createDeepSeekToolHost({ conversationId, sessionId });
      if (intermediate && !pending) {
        pending = { sessionId, turnId: sourceTurnId!, text, tools: host.tools, completedCalls: new Map() };
        pendingReplies.set(inputId, pending);
      }
      const outcome = await runDeepSeekTurn(text, {
        tools: pending?.tools ?? host.tools,
        completedCalls: pending?.completedCalls,
        current,
        execute: async call => {
          const result = await host.run(call.name, call.arguments);
          return { text: deepSeekToolResultText(result), isError: result.isError === true };
        }
      });
      if (outcome.status === 'stopped') {
        pendingReplies.delete(inputId);
        return { status: 200, body: { ok: true, status: 'stopped' } };
      }
      if (outcome.status === 'answer') {
        if (stopRequested(conversationId, turnId)) return { status: 200, body: { ok: true, status: 'stopped' } };
        const role = finishWorker ? await finishWorker(conversationId, outcome.text) : 'not-worker';
        if (role === 'not-durable') return { status: 503, body: { error: 'worker_state_not_durable', retryable: true } };
        if (role === 'worker') return { status: 200, body: { ok: true, status: 'answer', worker: true } };
        // A settled, tool-free answer is this chat's completion boundary. Goal/Loop advances on
        // the same outbox the tool continuation uses, so the page needs no second transport.
        await advanceDeepSeekGoal({ conversationId, sessionId, messageId, text: outcome.text, ...(turnId ? { turnId } : {}) })
          .catch(err => logWarn(`deepseek: goal advance for ${conversationId} failed — ${err instanceof Error ? err.message : String(err)}`));
        return { status: 200, body: { ok: true, status: 'answer' } };
      }
      continuation = outcome.continuation;
      summary = outcome.status === 'tools' ? { status: 'tools', calls: outcome.calls } : { status: outcome.status, reason: outcome.reason };
      if (pending) pending.continuation = continuation;
    }

    // The continuation is model-facing work, so it goes through the one outbox every
    // app-authored message uses. DeepSeek has no connector: the only way a result reaches the
    // model is the page's own composer, and the tool finished after the answer that asked for
    // it had already settled. Freezing the row as a ChatGPT tool injection would hold it
    // forever behind a completion boundary this protocol never produces.
    if (!await current()) {
      pendingReplies.delete(inputId);
      return { status: 200, body: { ok: true, status: 'stopped' } };
    }
    await enqueueInput({ id: inputId, sessionId, text: continuation, authoredSource: 'none', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null },
      undefined, { transport: 'browser', deepSeekContinuation: { turnId: sourceTurnId!, messageId } });
    pendingReplies.delete(inputId);
    return {
      status: 200,
      body: { ok: true, ...summary, queued: inputId }
    };
  } catch (err) {
    // Ownership could be unreadable after an accepted call or while publishing its
    // continuation. Keep the source and bounded results; the same reply may retry them.
    try {
      if (intermediate && !await current()) {
        pendingReplies.delete(inputId);
        return { status: 200, body: { ok: true, status: 'stopped' } };
      }
    } catch { /* Unknown ownership is retryable, never permission to execute again. */ }
    logWarn(`deepseek: results for ${conversationId} are retained for retry — ${err instanceof Error ? err.message : String(err)}`);
    return { status: 503, body: { error: 'results_not_queued', retryable: true } };
  } finally {
    turnsInFlight.delete(inputId);
  }
}

/** Tests, and a bridge shutdown that must not inherit an old run, start from an empty set. */
export function resetDeepSeekReplies(): void {
  turnsInFlight.clear();
  pendingReplies.clear();
  stopRequested = () => false;
}
