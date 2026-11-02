/**
 * Worker reports for an idle DeepSeek prime chat.
 *
 * A prime reads its workers' reports at the end of its next tool result. A DeepSeek prime that
 * has already answered makes no further call, so its reports would wait until the person types
 * again. When that chat is idle, this files one app note through the normal outbox asking it to
 * read them with `agents` `status`; that call's result carries the reports and the existing
 * offer/acknowledge rules retire them. A Goal chat is left to the Goal adapter, which already
 * asks for the same read once its workers stop.
 */

import { createHash } from 'node:crypto';
import { onWorkerFinished, unreadPrimeReportIds, workerPrimeOwner } from '../agents.js';
import { goalArmedFor } from '../goal.js';
import { logInfo, logWarn } from '../logger.js';
import { enqueueInput } from '../session/input.js';
import { isChatBlocked } from '../session/blocked-chats.js';
import { conversationWasSuperseded, findSessionByConversation } from '../session/store.js';
import { WORKER_REPORTS_HEADER } from '../../shared/deepseek-display.js';

const RECHECK_MS = 5_000;
/** Primes with reports that may still need a note; checked until each has none unread. */
const watched = new Set<string>();
/** The newest unread-report set each prime was already woken for. */
const wokenFor = new Map<string, string>();
let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;

/** Model-facing. */
export function workerReportsNote(count: number): string {
  return `${WORKER_REPORTS_HEADER} ${count} new report${count === 1 ? '' : 's'} arrived after your last answer. ` +
    'Call the agents tool with action "status" to read them, then give the user the results they asked for.';
}

function inputIdFor(conversationId: string, ids: readonly string[]): string {
  const digest = createHash('sha256').update(`deepseek-worker-reports:${conversationId}:${ids.join(',')}`, 'utf8').digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Files the note for one prime when it is idle and has reports it was not yet woken for. */
export async function wakeIdlePrime(conversationId: string): Promise<'woken' | 'none' | 'busy' | 'skipped'> {
  const ids = unreadPrimeReportIds(conversationId).sort();
  if (!ids.length) { wokenFor.delete(conversationId); return 'none'; }
  const key = ids.join(',');
  if (wokenFor.get(conversationId) === key) return 'skipped';
  if (goalArmedFor(conversationId) || isChatBlocked(conversationId) || await conversationWasSuperseded(conversationId)) return 'skipped';
  const session = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!session) return 'skipped';
  // A running turn reads the reports on its own next tool result; look again once it ends.
  if (session.activeTurnId) return 'busy';
  await enqueueInput({
    id: inputIdFor(conversationId, ids),
    sessionId: session.id,
    text: workerReportsNote(ids.length),
    mode: 'auto',
    dueAt: Date.now(),
    model: null,
    reasoningEffort: null,
    authoredSource: 'none'
  }, undefined, { transport: 'browser' });
  wokenFor.set(conversationId, key);
  logInfo(`deepseek: told idle prime ${conversationId} about ${ids.length} worker report(s)`);
  return 'woken';
}

async function checkWatched(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    for (const conversationId of [...watched]) {
      const outcome = await wakeIdlePrime(conversationId).catch(err => {
        logWarn(`deepseek: could not pass worker reports to ${conversationId} — ${err instanceof Error ? err.message : String(err)}`);
        return 'busy' as const;
      });
      if (outcome !== 'busy') watched.delete(conversationId);
    }
  } finally {
    checking = false;
    if (!watched.size && timer) { clearInterval(timer); timer = null; }
  }
}

function watch(primeConversationId: string): void {
  watched.add(primeConversationId);
  if (!timer) { timer = setInterval(() => void checkWatched(), RECHECK_MS); timer.unref?.(); }
  // A finish is announced while the broker is still committing it; look again just after.
  setTimeout(() => void checkWatched(), 0);
}

let installed: (() => void) | null = null;

/** Starts watching worker finishes. Returns the uninstaller (tests). */
export function installDeepSeekWorkerReports(): () => void {
  installed ??= onWorkerFinished(workerConversationId => {
    const prime = workerPrimeOwner(workerConversationId).primeConversationId;
    if (prime) watch(prime);
  });
  return () => {
    installed?.(); installed = null;
    watched.clear(); wokenFor.clear();
    if (timer) { clearInterval(timer); timer = null; }
  };
}
