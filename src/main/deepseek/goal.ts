/**
 * Goal and Loop on a DeepSeek chat.
 *
 * ChatGPT drives Goal from its page: the page asks for a draft, types the reply, and retires the
 * reply obligation. DeepSeek has no such page protocol, but it already has the two owners this
 * needs — the per-chat switch/objective in `goal.ts`, and the outbox every browser message goes
 * through. A settled answer is the completion boundary, exactly as it is for the tool
 * continuation in `reply.ts`; the marker contract decides the rest.
 *
 * This is deliberately one adapter, not another controller: it writes the same goal state the
 * ChatGPT path writes and files the next step through `enqueueInput`. The DeepSeek page then
 * types that row through the delivery path it already runs for tool results.
 */

import { createHash } from 'node:crypto';
import { onWorkerFinished, waitingForSubAgents } from '../agents.js';
import { getConfig } from '../config.js';
import {
  goalArmedFor,
  goalObjectiveFor,
  goalSwitchFor,
  isGoalDecisionChat,
  noteGoalMetNow,
  setGoalSwitchNow
} from '../goal.js';
import { logInfo, logWarn } from '../logger.js';
import { cancelGoalStepInputs, enqueueInput } from '../session/input.js';
import { recordNote } from '../session/recorder.js';
import { conversationWasSuperseded, findSessionByConversation } from '../session/store.js';
import { isChatBlocked } from '../session/blocked-chats.js';
import { GOAL_COMPLETE_MARKER, GOAL_CONTINUE_MARKER, templateGoalDecision } from '../../shared/goal-templates.js';

export type DeepSeekGoalAdvance = 'continued' | 'met' | 'paused' | 'ignored' | 'waiting';

type DeepSeekGoalInput = Parameters<typeof advanceDeepSeekGoal>[0];

/**
 * Answers whose Goal/Loop decision waits for the chat's own workers (waitForSubAgents, or the
 * step reviewer's hold). Their reports change what the next step should be, so the decision is
 * taken once they stop, from the newest answer. Process memory only: after a restart the next
 * answer decides.
 */
const heldForWorkers = new Map<string, DeepSeekGoalInput>();
let workerWatch: ReturnType<typeof setInterval> | null = null;
let stopFinishWatch: (() => void) | null = null;
const WORKER_RECHECK_MS = 15_000;

/** Model-facing: a "complete" written before the workers' reports were in is not trusted yet. */
const WORKERS_DONE_STEP =
  'Your workers stopped after your last answer, so their reports were not part of it. Read them with the agents tool (action "status"), ' +
  `then finish the goal. End your answer with ${GOAL_COMPLETE_MARKER} when it is met, or ${GOAL_CONTINUE_MARKER} when work remains.`;

function holdForWorkers(input: DeepSeekGoalInput): void {
  heldForWorkers.set(input.conversationId, input);
  if (!workerWatch) {
    workerWatch = setInterval(() => void releaseHeldGoals(), WORKER_RECHECK_MS);
    workerWatch.unref?.();
  }
  // A finish is announced while the broker is still committing it; look again just after.
  stopFinishWatch ??= onWorkerFinished(() => { setTimeout(() => void releaseHeldGoals(), 0); });
}

async function releaseHeldGoals(): Promise<void> {
  for (const [conversationId, input] of [...heldForWorkers]) {
    if (waitingForSubAgents(conversationId)) continue;
    if (heldForWorkers.get(conversationId) !== input) continue;
    heldForWorkers.delete(conversationId);
    await advanceDeepSeekGoal(input, true).catch(err =>
      logWarn(`deepseek goal: the held step for ${conversationId} failed — ${err instanceof Error ? err.message : String(err)}`));
  }
  if (heldForWorkers.size === 0) {
    if (workerWatch) clearInterval(workerWatch);
    workerWatch = null;
    stopFinishWatch?.();
    stopFinishWatch = null;
  }
}

/** One settled answer may advance its chat's Goal once, even if a page reports it twice. */
const lastAdvanced = new Map<string, string>();
const MAX_LAST_ADVANCED = 200;

function remember(conversationId: string, messageId: string): void {
  lastAdvanced.delete(conversationId);
  lastAdvanced.set(conversationId, messageId);
  while (lastAdvanced.size > MAX_LAST_ADVANCED) lastAdvanced.delete(lastAdvanced.keys().next().value!);
}

function slotFor(messageId: string): number {
  return createHash('sha256').update(messageId, 'utf8').digest().readUInt32BE(0);
}

/** The stable outbox identity of the step that follows one settled answer. */
export function deepSeekGoalStepId(conversationId: string, messageId: string): string {
  const digest = createHash('sha256').update(`deepseek-goal:${conversationId}:${messageId}`, 'utf8').digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Reads one settled answer's marker and either files the next step or ends the run.
 *
 * Called only for an answer that needed no tools: a tool request is an intermediate model turn,
 * and its result continuation is already the next message in the same turn.
 */
export async function advanceDeepSeekGoal(input: {
  conversationId: string;
  sessionId: string;
  turnId?: string;
  messageId: string;
  text: string;
}, afterWorkers = false): Promise<DeepSeekGoalAdvance> {
  const { conversationId, sessionId, messageId, text } = input;
  if (!getConfig().sessions.record) return 'ignored';
  if (lastAdvanced.get(conversationId) === messageId) return 'ignored';
  if (isGoalDecisionChat(conversationId) || !goalArmedFor(conversationId)) return 'ignored';
  if (isChatBlocked(conversationId) || await conversationWasSuperseded(conversationId)) return 'ignored';
  if (waitingForSubAgents(conversationId)) {
    holdForWorkers(input);
    logInfo(`deepseek goal: ${conversationId} waits for its workers before the next step`);
    return 'waiting';
  }
  // A newer answer replaces one still waiting; it is the one decided on.
  heldForWorkers.delete(conversationId);

  const mode = goalSwitchFor(conversationId).mode;
  const slot = slotFor(messageId);
  let decision = templateGoalDecision(text, slot, slot + 1, mode);
  if (afterWorkers && decision.action === 'stop') decision = { action: 'continue', reply: WORKERS_DONE_STEP };
  const objective = goalObjectiveFor(conversationId);
  const subject = objective ? `“${objective.length > 80 ? `${objective.slice(0, 77)}...` : objective}”` : 'this chat’s goal';

  if (decision.action === 'invalid') {
    // Missing or misplaced marker: the transport cannot prove the objective is met, and asking
    // again on a guess would loop forever. Pause where the person can see the state.
    remember(conversationId, messageId);
    await setGoalSwitchNow(conversationId, 'goal', false).catch(() => undefined);
    await cancelGoalStepInputs(conversationId, 'Goal paused: the answer did not end with a goal marker.').catch(() => 0);
    await recordNote(sessionId,
      `Goal paused: the answer did not end with [[COS_GOAL:COMPLETE]] or [[COS_GOAL:CONTINUE]], so ${subject} is not proven finished. ` +
      'Check the chat, then switch Goal back on to continue.');
    logInfo(`deepseek goal: ${conversationId} paused — ${decision.error}`);
    return 'paused';
  }

  if (decision.action === 'stop') {
    remember(conversationId, messageId);
    await setGoalSwitchNow(conversationId, 'goal', false).catch(() => undefined);
    await cancelGoalStepInputs(conversationId, 'Goal was met before this step was sent.').catch(() => 0);
    await noteGoalMetNow(conversationId, input.turnId ?? messageId, 'DeepSeek', 'templates');
    await recordNote(sessionId, `Goal met: DeepSeek marked ${subject} complete.`);
    logInfo(`deepseek goal: ${conversationId} met; goal switched off`);
    return 'met';
  }

  const id = deepSeekGoalStepId(conversationId, messageId);
  // DeepSeek has no helper page holding the saved objective beside the transcript: restate it
  // with every step, or a later round can answer an older goal and call that complete.
  const stepText = objective
    ? `Saved goal for this chat (the finish line):\n${objective}\n\n${decision.reply}`
    : decision.reply;
  try {
    await enqueueInput({
      id,
      sessionId,
      text: stepText,
      mode: 'auto',
      dueAt: Date.now(),
      model: null,
      reasoningEffort: null,
      authoredSource: 'none',
      goalStep: { conversationId, messageId }
    }, undefined, { transport: 'browser' });
  } catch (error) {
    // A person's newer message owning the queue wins; the answer still stays recorded. Do not
    // retry behind their back, and do not spend the next step twice.
    remember(conversationId, messageId);
    logWarn(`deepseek goal: the next step for ${conversationId} was not queued — ${error instanceof Error ? error.message : String(error)}`);
    return 'ignored';
  }
  remember(conversationId, messageId);
  logInfo(`deepseek goal: queued the next ${mode} step for ${conversationId} as ${id}`);
  return 'continued';
}

/**
 * Pauses this chat's armed Goal/Loop when DeepSeek refuses more messages.
 *
 * A rate-limit notice is not a final answer and proves nothing about the objective, yet Loop
 * continues through every ordinary answer. The provider's refusal therefore has to be its own
 * boundary: switch automation off first, withdraw the step already waiting in the outbox, and
 * leave a visible note. No completion is recorded — the work is not done, only paused.
 */
export async function pauseDeepSeekGoalForThrottle(conversationId: string): Promise<boolean> {
  if (isGoalDecisionChat(conversationId) || !goalArmedFor(conversationId)) return false;
  const mode = goalSwitchFor(conversationId).mode;
  const label = mode === 'loop' ? 'Loop' : 'Goal';
  await setGoalSwitchNow(conversationId, mode, false).catch(() => undefined);
  await cancelGoalStepInputs(conversationId, `${label} paused: DeepSeek asked to slow down.`).catch(() => 0);
  const session = await findSessionByConversation(conversationId).catch(() => null);
  if (session) {
    await recordNote(session.id,
      `${label} paused: DeepSeek reported “Messages too frequent. Try again later.” No further ${mode} steps were sent. ` +
      `When the chat accepts messages again, switch ${label} back on to continue.`);
  }
  logWarn(`deepseek goal: ${conversationId} paused — the page is rate limiting messages`);
  return true;
}

/** Tests start each case from an empty duplicate fence. */
export function resetDeepSeekGoalForTests(): void {
  lastAdvanced.clear();
  heldForWorkers.clear();
  if (workerWatch) clearInterval(workerWatch);
  workerWatch = null;
  stopFinishWatch?.();
  stopFinishWatch = null;
}
