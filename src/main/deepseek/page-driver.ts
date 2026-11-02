/**
 * The DeepSeek page, driven from inside the app.
 *
 * Chat On Steroids talks to ChatGPT through a browser extension. DeepSeek has no connector
 * protocol and no extension to carry its page, so the same job — read the transcript, deliver
 * the app's next message, notice when an answer is finished — is done here, against the
 * built-in browser's own `WebContents`. The app-facing seams are unchanged: observations go
 * through `recordChatObservations`, deliveries through the same input claim/ack pair, and a
 * finished answer through the one DeepSeek reply path.
 *
 * A brand-new chat is the one case the extension used to solve with a URL marker: DeepSeek has
 * no conversation id until its first message is sent. The page the app opens carries
 * `cos-input=<outbox id>`, so the driver claims exactly that row, types it, then waits for the
 * page to acquire its conversation id and acknowledges the row with it. That is the same
 * null -> id binding every desktop send needs, without guessing a conversation from a title.
 *
 * This driver is deliberately additive: it only ever touches chat.deepseek.com documents.
 */

import { isDeepSeekHelperContents } from './helper-contents.js';
import type { WebContents } from 'electron';
import { cosBrowserSignedIn, setCosBrowserSignedIn } from '../cos-browser/sign-in.js';
import { noteDeepThinkControl } from '../chat-models.js';
import { logInfo, logWarn } from '../logger.js';
import { mainText } from '../main-texts.js';
import {
  acknowledgeBrowserInput,
  authorizeBrowserInput,
  claimBrowserInput,
  failBrowserInput,
  holdInputForSignIn,
  pendingBrowserInputs,
  SEND_WITHDRAWN
} from '../session/input.js';
import { recordChatObservations, recordNote } from '../session/recorder.js';
import { findSessionByConversation } from '../session/store.js';
import { userPromptText } from '../../shared/user-prompt.js';
import {
  DEEPSEEK_SNAPSHOT_SCRIPT,
  DEEPSEEK_STOP_SCRIPT,
  deepSeekHistoryScript,
  deepSeekMessageIdAt,
  deepSeekObservations,
  deepSeekDeepThinkProbeScript,
  deepSeekSendScript,
  type DeepSeekSendSelection,
  type DeepSeekSendResult,
  type DeepSeekHistoryResult,
  type DeepSeekPageMessage,
  type DeepSeekPageSnapshot
} from './page.js';
import { pauseDeepSeekGoalForThrottle } from './goal.js';
import { deliverDeepSeekReply } from './reply.js';
import { parseDeepSeekReply } from './tool-protocol.js';
import { isDeepSeekUrl } from './site.js';

/**
 * The broker seam a worker-command page uses.
 *
 * A worker's fresh chat is still a broker command: the bridge owns its identity, deadline, send
 * check, worktree and binding. The page only carries it out, which is what the extension used to
 * do for ChatGPT. The bridge installs this once at startup and tests inject a fake.
 */
export interface DeepSeekWorkerBridge {
  /** Commit page observations and apply the recorder's verdict to the bridge activity clock. */
  observe?: typeof recordChatObservations;
  claim: (id: string, client: string) => Promise<({ ok: true; text: string } & DeepSeekSendSelection) | { ok: false; error: string; retryable?: boolean }>;
  ack: (id: string, client: string, conversationId: string | null, error?: string) => Promise<{ ok: boolean; error?: string; retryable?: boolean }>;
  /** Claims the oldest wake waiting for this page's own conversation. */
  claimPendingRevival?: (conversationId: string, client: string) => Promise<({ ok: true; id: string; text: string } & DeepSeekSendSelection) | { ok: false; error: string; retryable?: boolean }>;
  /** Claims the Stop the person asked for in this page's own conversation. */
  claimPendingStop?: (conversationId: string, client: string) => Promise<{ ok: true; id: string; turnId: string } | { ok: false; error: string }>;
  /** Reports whether the claimed Stop ended the page's generation. */
  ackStop?: (id: string, client: string, conversationId: string, turnId: string, stopped: boolean, error?: string) => Promise<{ ok: boolean; error?: string }>;
  /** The page's own word that its turn is (still) running, for the broker's silence sweep. */
  noteActivity?: (conversationId: string, generating: boolean) => Promise<void>;
  /** Fails a wake this page cannot carry into its conversation. */
  failRevival?: (id: string, client: string, reason: string) => Promise<{ ok: boolean; error?: string; retryable?: boolean }>;
}

let workerBridge: DeepSeekWorkerBridge | null = null;

export function setDeepSeekWorkerBridge(bridge: DeepSeekWorkerBridge | null): void {
  workerBridge = bridge;
}

/** Whether this process has a page consumer for worker wakes and bootstraps. */
export function deepSeekWorkerPagesAttached(): boolean {
  return workerBridge !== null;
}

/** Fast enough to look live, slow enough not to make the page's own renderer work. */
const POLL_MS = 700;
/** Quiet DOM text is a candidate for checking the provider's completion evidence. */
const SETTLE_MS = 1_500;
/** Reuse the page poll; history needs checking at most once every two seconds. */
const HISTORY_CHECK_MS = 2_000;
/** A sent message must become a conversation; past this the outbox row is shown as failed. */
const BIND_TIMEOUT_MS = 90_000;
/** The page's new question may not be readable yet; acknowledge without its id after this. */
const ACK_FALLBACK_MS = 6_000;
/** A fresh page can still be painting its composer; do not fail a worker before this. */
const COMPOSER_WAIT_MS = 30_000;
/** Enough of the sent text to recognize it on the page without depending on full equality. */
const MATCH_CHARS = 120;
/** A failed hand-off of a finished answer is retried after each of these waits, then reported. */
const CUSTODY_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
/** How long a clicked Stop may take to end the page's generation before it counts as failed. */
const STOP_CONFIRM_MS = 5_000;
const STOP_POLL_MS = 250;
/** A still-running page renews its activity mark this often; the broker only needs a fresh one. */
const ACTIVITY_MS = 10_000;
/** A reply that asks for tools; a stopped one must say they were not run. */
const TOOL_ENVELOPE = /"type"\s*:\s*"tool_calls"/;

/** How often an idle signed-in page is checked for its DeepThink toggle. */
const DEEPTHINK_PROBE_MS = 15_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** A finished answer in the driver's custody until it is recorded and handed to the reply path. */
interface FinalJob {
  conversationId: string;
  observations: ReturnType<typeof deepSeekObservations>;
  text: string;
  textFormat: 'plain' | 'markdown';
  messageId: string;
  turnId?: string;
  /** Stopped or cut off: recorded as it is, never parsed for tools, never continued. */
  incomplete: boolean;
  /** Whether a tool request may be carried to the reply path (the page is still current). */
  deliver: boolean;
  recorded: boolean;
  sessionId: string | null;
}

interface DriverState {
  previous: DeepSeekPageSnapshot | null;
  conversationId: string | null;
  lastText: string;
  changedAt: number;
  finalSent: boolean;
  /** The person stopped this turn: its answer is recorded but never runs tools or continues. */
  stopped: boolean;
  /** The person's last question when Stop was carried, so a newer one ends the stop. */
  stoppedQuestion: string | null;
  stoppedTurnId: string | null;
  nextHistoryCheckAt: number;
  /** What the broker was last told about this chat's generation, and when. */
  generating: boolean;
  activityAt: number;
  /** One send per tick: deliveries keep their order without a burst. */
  sending: boolean;
}

/**
 * A message the page accepted whose exact conversation is not known yet (a new chat), or whose
 * new user row has not appeared yet (an existing chat). It holds the next delivery until the
 * page proves where the message went.
 */
interface AwaitingBind {
  id: string;
  owner: string;
  text: string;
  /** User rows already on the page when the message was typed. */
  baseline: number;
  since: number;
  /** The conversation this message belongs to; null for a new chat. */
  conversationId: string | null;
  /** A new worker has no local session until the bridge accepts its binding. */
  selectionWarnings?: string[];
}

interface RevivalOpening extends DeepSeekSendSelection {
  id: string;
  text: string;
  since: number;
  /** Matching rows already on the page when this wake was claimed. */
  baseline: number;
  /** Absolute row keys already visible then; a virtual list may scroll them out. */
  seenKeys: Set<string>;
  /** A failed composer attempt must settle before it is tried again. */
  retryAt: number;
}

interface OpeningSend extends DeepSeekSendSelection {
  id: string;
  text: string;
  since: number;
  /** A failed composer attempt must settle before it is tried again. */
  retryAt: number;
  sessionId?: string | null;
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The page row carrying a message the driver typed, or -1 while it is not visible yet. */
function sentRowIndex(messages: readonly DeepSeekPageMessage[], awaiting: AwaitingBind): number {
  // Compare the authored task, not the transport frame: a page that reads the frame back with
  // Markdown escapes still says the same thing in the part the person wrote.
  const sent = userPromptText(awaiting.text) || awaiting.text;
  const needle = normalized(sent).slice(0, MATCH_CHARS);
  if (!needle) return -1;
  for (let index = messages.length - 1; index >= awaiting.baseline; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'user') continue;
    const authored = userPromptText(message.text) || message.text;
    if (normalized(authored).includes(needle)) return index;
  }
  return -1;
}

/** How many visible question rows carry this exact authored text. */
function matchingUserRows(messages: readonly DeepSeekPageMessage[], text: string): number {
  const sent = userPromptText(text) || text;
  const needle = normalized(sent).slice(0, MATCH_CHARS);
  if (!needle) return 0;
  return messages.filter(message => message.role === 'user' &&
    normalized(userPromptText(message.text) || message.text).includes(needle)).length;
}

/**
 * Whether a claimed wake is now on the page beyond the rows that existed when it was claimed.
 *
 * The virtual list exposes absolute row keys, so a matching row with an unseen key is the wake
 * even when an older matching row has scrolled out of the visible window. A DOM without those
 * keys falls back to the visible count, which is the strongest proof it offers.
 */
function wakeLanded(snapshot: DeepSeekPageSnapshot, opening: RevivalOpening): boolean {
  const sent = userPromptText(opening.text) || opening.text;
  const needle = normalized(sent).slice(0, MATCH_CHARS);
  if (!needle) return false;
  for (const message of snapshot.messages) {
    if (message.role !== 'user') continue;
    const authored = userPromptText(message.text) || message.text;
    if (!normalized(authored).includes(needle)) continue;
    if (message.key && !opening.seenKeys.has(message.key)) return true;
  }
  return matchingUserRows(snapshot.messages, opening.text) > opening.baseline;
}

export class DeepSeekPageDriver {
  private readonly owner: string;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private deepThinkProbedAt = 0;
  private disposed = false;
  private navigationEpoch = 0;
  private readonly navigationStarted = (details: { isMainFrame: boolean }): void => {
    if (!details.isMainFrame) return;
    this.navigationEpoch += 1;
    this.state.conversationId = null;
  };
  private readonly historyWarnings = new Set<string>();
  private awaiting: AwaitingBind | null = null;
  /** An ordinary new-chat opening this page has claimed and is typing. */
  private openingSend: OpeningSend | null = null;
  /** A broker worker bootstrap this page has claimed but not yet typed. */
  private workerOpening: { id: string; text: string; since: number } | null = null;
  /** A typed worker bootstrap whose conversation/user row the page has not proved yet. */
  private awaitingWorker: AwaitingBind | null = null;
  private workerSending = false;
  /** A wake this page claimed and is typing into the worker's existing conversation. */
  private revivalOpening: RevivalOpening | null = null;
  /** A wake already typed, waiting for the bridge's durable receipt. */
  private revivalAwaitingAck: { id: string; conversationId: string } | null = null;
  private revivalSending = false;
  /** One bridge check a second is enough to notice a wake without polling it constantly. */
  private nextRevivalCheckAt = 0;
  /** Bounded per document: the last commands this page carried, so a wake is never re-claimed. */
  private readonly handledRevivals = new Set<string>();
  /** Finished answers still being recorded or handed over; nothing new is typed meanwhile. */
  private custodies = 0;
  private state: DriverState = {
    previous: null,
    conversationId: null,
    lastText: '',
    changedAt: 0,
    finalSent: false,
    stopped: false,
    stoppedQuestion: null,
    stoppedTurnId: null,
    nextHistoryCheckAt: 0,
    generating: false,
    activityAt: 0,
    sending: false
  };

  constructor(private readonly contents: WebContents) {
    this.owner = `deepseek-page:${contents.id}`;
    contents.on('did-start-navigation', this.navigationStarted);
  }

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref?.();
    logInfo(`deepseek: page driver attached to webContents ${this.contents.id}`);
  }

  stop(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.contents.removeListener('did-start-navigation', this.navigationStarted);
  }

  private async evaluate<T>(script: string): Promise<T | null> {
    try {
      return (await this.contents.executeJavaScript(script, true)) as T;
    } catch {
      // A navigating or destroyed frame rejects; the next tick tries again.
      return null;
    }
  }

  private record(...args: Parameters<typeof recordChatObservations>): ReturnType<typeof recordChatObservations> {
    return (workerBridge?.observe ?? recordChatObservations)(...args);
  }

  /** All page sends apply the exact claimed selection before touching the composer. */
  private async send(text: string, selection: DeepSeekSendSelection, sessionId?: string | null, conversationId?: string | null): Promise<DeepSeekSendResult | null> {
    const result = await this.evaluate<DeepSeekSendResult>(deepSeekSendScript(text, selection, this.contents.getURL()));
    if (typeof result?.deepThink === 'boolean') noteDeepThinkControl(result.deepThink);
    if (result?.warnings?.length) {
      for (const control of result.warnings) logWarn(`deepseek: could not confirm ${control}; sending with the page's current setting`);
      const owner = sessionId ?? (conversationId ? (await findSessionByConversation(conversationId, { requireUnique: true }).catch(() => null))?.id : null);
      if (owner && result.ok) await this.noteSelectionWarnings(owner, result.warnings);
    }
    return result;
  }

  private async noteSelectionWarnings(sessionId: string, warnings: string[]): Promise<void> {
    for (const control of warnings) await recordNote(sessionId,
      mainText("DeepSeek could not confirm {0}. The message was sent with the page's current setting.").replace('{0}', control)).catch(() => undefined);
  }

  private reset(): void {
    this.state = { previous: null, conversationId: null, lastText: '', changedAt: 0, finalSent: false, stopped: false, stoppedQuestion: null, stoppedTurnId: null, nextHistoryCheckAt: 0, generating: false, activityAt: 0, sending: false };
    // A wake or opening belongs to the document it was claimed on; a different one is not it.
    this.revivalOpening = null;
    this.revivalAwaitingAck = null;
    this.openingSend = null;
  }

  /** A send that never became a conversation must not stay invisible in the outbox. */
  private async expireAwaiting(now = Date.now()): Promise<void> {
    const awaiting = this.awaiting;
    if (!awaiting || now - awaiting.since < BIND_TIMEOUT_MS) return;
    this.awaiting = null;
    await failBrowserInput(awaiting.id, awaiting.owner, 'DeepSeek did not open a conversation for this message', 'no-conversation')
      .catch(() => false);
    logWarn(`deepseek: input ${awaiting.id} was sent but no conversation appeared`);
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    if (this.contents.isDestroyed()) {
      this.stop();
      return;
    }
    await this.expireAwaiting();
    if (!isDeepSeekUrl(this.contents.getURL())) {
      if (this.state.conversationId) this.reset();
      return;
    }
    this.ticking = true;
    try {
      const epoch = this.navigationEpoch;
      const snapshot = await this.evaluate<DeepSeekPageSnapshot>(DEEPSEEK_SNAPSHOT_SCRIPT);
      if (!snapshot || !this.currentPage(epoch, snapshot.url)) return;
      setCosBrowserSignedIn(snapshot.signedIn);
      if (!snapshot.signedIn) {
        // A page opened for one exact new chat proves which outbox row is waiting; tell that
        // row to sign in instead of leaving it silently queued behind a login screen.
        if (snapshot.inputMarker) {
          const row = (await pendingBrowserInputs()).find(candidate => candidate.id === snapshot.inputMarker);
          if (row && this.currentPage(epoch, snapshot.url) && cosBrowserSignedIn() !== true)
            await holdInputForSignIn(row.id, this.owner).catch(() => false);
        }
        // A worker's bootstrap cannot proceed without an account. Say so on its exact command
        // so the broker fails that slot instead of leaving the prime waiting forever.
        if (snapshot.commandMarker) await this.failWorkerCommand(snapshot.commandMarker, 'Sign in to DeepSeek in the app’s browser');
        return;
      }
      // The model picker offers DeepThink only while the page shows it; check now and then.
      if (!this.state.sending && Date.now() - this.deepThinkProbedAt >= DEEPTHINK_PROBE_MS) {
        this.deepThinkProbedAt = Date.now();
        const deepThink = await this.evaluate<boolean | null>(deepSeekDeepThinkProbeScript());
        if (typeof deepThink === 'boolean') noteDeepThinkControl(deepThink);
      }
      if (!snapshot.conversationId) {
        if (this.state.conversationId) this.reset();
        // A broker worker page is not an ordinary opening: its message is the bridge's exact
        // command, never whichever outbox row happens to be waiting.
        if (snapshot.commandMarker) {
          await this.deliverWorkerOpening(snapshot);
          return;
        }
        if (!this.awaiting) await this.deliverOpening(snapshot);
        return;
      }
      // Binding first is load-bearing for a new chat: recording its first observation would
      // create a session for the conversation before the reserved opening session could own it.
      if (this.awaitingWorker) {
        await this.bindWorker(snapshot);
        if (this.awaitingWorker) return;
      }
      if (this.awaiting) {
        await this.bindAwaiting(snapshot);
        if (this.awaiting) return;
      }
      // Pause before observing: a settled answer must not advance Loop into another send
      // while the page is refusing messages. The switch-off also cancels the step already
      // waiting in the outbox, so the delivery below cannot type it.
      if (snapshot.throttled) {
        const paused = await pauseDeepSeekGoalForThrottle(snapshot.conversationId).catch(err => {
          logWarn(`deepseek: could not pause ${snapshot.conversationId} after throttling — ${err instanceof Error ? err.message : String(err)}`);
          return false;
        });
        if (paused) logWarn(`deepseek: paused automation for ${snapshot.conversationId} — the page is rate limiting messages`);
      }
      await this.carryStop(snapshot);
      if (!this.currentPage(epoch, snapshot.url)) return;
      await this.observe(snapshot);
      if (!this.currentPage(epoch, snapshot.url)) return;
      // The app's own outbox keeps its order. A finish's tool-result continuation is a real
      // message in this conversation, and a wake must not jump ahead of it.
      if (await this.deliver(snapshot)) return;
      // A wake lands in the worker's own chat. It is a bridge command, not an outbox row.
      if (this.revivalAwaitingAck || this.revivalOpening || workerBridge?.claimPendingRevival) {
        await this.deliverRevival(snapshot);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Runs one broker worker bootstrap on the page the bridge opened for it.
   *
   * The command is the authority: the page claims exactly the marker it was opened with, types
   * the text the bridge prepared, and waits for DeepSeek's own conversation id and user row.
   * Only then is the command acknowledged, which is the transition that binds the worker slot.
   */
  private async deliverWorkerOpening(snapshot: DeepSeekPageSnapshot): Promise<void> {
    const id = snapshot.commandMarker;
    if (!id || !workerBridge || this.workerSending || this.awaitingWorker) return;
    if (this.workerOpening && this.workerOpening.id !== id) this.workerOpening = null;
    this.workerSending = true;
    try {
      const claimed = await workerBridge.claim(id, this.owner).catch(() => null);
      if (!claimed) return;
      if (!claimed.ok) {
        // Retryable means the bridge still holds the command; anything else is final and the
        // bridge has already failed the worker or superseded the run.
        if (!claimed.retryable) this.workerOpening = null;
        return;
      }
      this.workerOpening ??= { id, text: claimed.text, since: Date.now() };
      const sent = await this.send(claimed.text, claimed);
      // A missing result is a navigating document, not a refusal: the page may already have
      // turned this send into a conversation. Sending can also navigate before the script sees
      // the composer clear, so that new id is the real receipt either way.
      if (!sent || !sent.ok) {
        const after = await this.evaluate<DeepSeekPageSnapshot>(DEEPSEEK_SNAPSHOT_SCRIPT);
        if (after?.conversationId) {
          const baseline = snapshot.messages.filter(message => message.role === 'user').length;
          this.awaitingWorker = { id, owner: this.owner, text: claimed.text, baseline, since: Date.now(), conversationId: null, selectionWarnings: sent?.warnings };
          this.workerOpening = null;
          logInfo(`deepseek: worker bootstrap ${id} became ${after.conversationId}; waiting for its row`);
          return;
        }
        if (!sent) return;
        // A fresh page can have its composer before React has wired it. Retry the same value
        // for the same bounded window as a missing composer, instead of failing the slot.
        if (Date.now() - this.workerOpening.since < COMPOSER_WAIT_MS) {
          logWarn(`deepseek: worker bootstrap ${id} not ready to send — ${sent.reason} ${JSON.stringify(sent.detail ?? {})}`);
          return;
        }
        logWarn(`deepseek: worker bootstrap ${id} could not be sent — ${sent.reason} ${JSON.stringify(sent.detail ?? {})}`);
        await this.failWorkerCommand(id, sent.reason || 'no-composer');
        return;
      }
      const baseline = snapshot.messages.filter(message => message.role === 'user').length;
      this.awaitingWorker = { id, owner: this.owner, text: claimed.text, baseline, since: Date.now(), conversationId: null, selectionWarnings: sent.warnings };
      this.workerOpening = null;
      this.state.changedAt = Date.now();
      this.state.lastText = '';
      logInfo(`deepseek: worker bootstrap ${id} typed; waiting for its conversation`);
    } finally {
      this.workerSending = false;
    }
  }

  /** Binds a typed worker bootstrap to the conversation and question the page shows. */
  private async bindWorker(snapshot: DeepSeekPageSnapshot): Promise<void> {
    const awaiting = this.awaitingWorker;
    if (!awaiting || !workerBridge || !snapshot.conversationId) return;
    // The page was opened for one exact bootstrap. If it now carries another marker, the tab
    // was navigated to somebody else's command and this conversation is not this worker's.
    if (snapshot.commandMarker && snapshot.commandMarker !== awaiting.id) {
      this.awaitingWorker = null;
      await this.failWorkerCommand(awaiting.id, 'the page changed to another bootstrap');
      return;
    }
    const index = sentRowIndex(snapshot.messages, awaiting);
    // The conversation id appears only after this page sends its first message, and this page
    // was opened for this command, so the id alone is enough after the fallback window. The
    // row is preferred because it proves the bootstrap itself landed.
    if (index < 0 && Date.now() - awaiting.since < ACK_FALLBACK_MS) return;
    const result = await workerBridge.ack(awaiting.id, this.owner, snapshot.conversationId).catch(() => null);
    // A bridge that could not answer has not refused: keep the pending bind and try again,
    // rather than abandoning a worker whose chat the page already started.
    if (!result) return;
    if (result.ok) {
      logInfo(`deepseek: worker bootstrap ${awaiting.id} bound to ${snapshot.conversationId}`);
      this.awaitingWorker = null;
      if (awaiting.selectionWarnings?.length) {
        const session = await findSessionByConversation(snapshot.conversationId, { requireUnique: true });
        if (session) await this.noteSelectionWarnings(session.id, awaiting.selectionWarnings);
      }
      return;
    }
    if (!result.retryable) {
      logWarn(`deepseek: worker bootstrap ${awaiting.id} could not be bound — ${result.error ?? 'command refused'}`);
      this.awaitingWorker = null;
    }
  }

  /**
   * Runs one sleeping-worker wake in the chat that worker already owns.
   *
   * The page's own conversation id is the address: the bridge hands back only a wake whose
   * exact conversation matches it, and the lease is what makes two pages unable to type the
   * same words. Delivery proof is the bridge's durable receipt, never the page's rendering.
   */
  private async deliverRevival(snapshot: DeepSeekPageSnapshot): Promise<void> {
    const conversation = snapshot.conversationId;
    const bridge = workerBridge;
    if (!conversation || !bridge?.claimPendingRevival) return;
    if (this.revivalAwaitingAck) {
      // The document moved to another chat before the receipt landed. That delivery is the
      // bridge's command to settle; this page must not keep blocking its new conversation.
      if (this.revivalAwaitingAck.conversationId !== conversation) {
        this.revivalAwaitingAck = null;
        this.revivalOpening = null;
      } else {
        await this.answerRevivalReceipt(bridge, snapshot);
        return;
      }
    }
    // A queued app message for this same chat goes first, even while the page is settling.
    if ((await pendingBrowserInputs()).some(row =>
      row.conversationId === conversation && row.lifetime !== 'temporary-planner')) return;
    if (this.revivalSending) return;
    const now = Date.now();
    if (!this.revivalOpening && now >= this.nextRevivalCheckAt) {
      this.nextRevivalCheckAt = now + 1_000;
      this.revivalSending = true;
      try {
        const claimed = await bridge.claimPendingRevival(conversation, this.owner).catch(() => null);
        if (claimed?.ok && !this.handledRevivals.has(claimed.id)) {
          this.revivalOpening = {
            id: claimed.id,
            text: claimed.text,
            model: claimed.model,
            reasoningEffort: claimed.reasoningEffort,
            since: Date.now(),
            baseline: matchingUserRows(snapshot.messages, claimed.text),
            seenKeys: new Set(snapshot.messages.flatMap(message => message.key ? [message.key] : [])),
            retryAt: 0
          };
        }
      } finally {
        this.revivalSending = false;
      }
    }
    const opening = this.revivalOpening;
    if (!opening) return;
    // A wake can land from the previous attempt even when that attempt reported no send
    // control. Check the page before retyping, or a slow render would be sent twice.
    if (wakeLanded(snapshot, opening)) {
      this.revivalOpening = null;
      this.revivalAwaitingAck = { id: opening.id, conversationId: conversation };
      this.state.changedAt = Date.now();
      this.state.lastText = '';
      logInfo(`deepseek: worker wake ${opening.id} already landed in ${conversation}`);
      await this.answerRevivalReceipt(bridge, snapshot);
      return;
    }
    // The chat is still writing its previous answer; typing now would interleave the wake.
    if (snapshot.busy || this.custodies > 0 || (snapshot.messages.at(-1)?.role === 'assistant' && !this.state.finalSent)) return;
    // A composer that was briefly unavailable needs a settle window. Retrying on the very next
    // tick can press Enter into a page that already accepted the first attempt but has not
    // painted its row yet.
    if (opening.retryAt > Date.now()) return;
    this.revivalSending = true;
    try {
      const sent = await this.send(opening.text, opening, undefined, conversation);
      // The document may still be navigating into place, or the page may have taken the wake
      // just before its composer cleared. Neither is a refusal: check the row first, then retry.
      if (!sent || !sent.ok) {
        const after = await this.evaluate<DeepSeekPageSnapshot>(DEEPSEEK_SNAPSHOT_SCRIPT);
        if (after && wakeLanded(after, opening)) {
          this.revivalOpening = null;
          this.revivalAwaitingAck = { id: opening.id, conversationId: conversation };
          this.state.changedAt = Date.now();
          this.state.lastText = '';
          logInfo(`deepseek: worker wake ${opening.id} landed in ${conversation} before its composer cleared`);
          await this.answerRevivalReceipt(bridge, after);
          return;
        }
        if (!sent) {
          opening.retryAt = Date.now() + SETTLE_MS;
          return;
        }
        if (Date.now() - opening.since < COMPOSER_WAIT_MS) {
          opening.retryAt = Date.now() + SETTLE_MS;
          logWarn(`deepseek: worker wake ${opening.id} not ready to send — ${sent.reason} ${JSON.stringify(sent.detail ?? {})}`);
          return;
        }
        await this.failRevival(opening.id, sent.reason || 'no-composer');
        return;
      }
      this.revivalOpening = null;
      this.revivalAwaitingAck = { id: opening.id, conversationId: conversation };
      this.state.changedAt = Date.now();
      this.state.lastText = '';
      logInfo(`deepseek: worker wake ${opening.id} typed into ${conversation}`);
      await this.answerRevivalReceipt(bridge, snapshot);
    } finally {
      this.revivalSending = false;
    }
  }

  /** Retires a typed wake on the bridge's own receipt; the page alone proves nothing. */
  private async answerRevivalReceipt(bridge: DeepSeekWorkerBridge, snapshot: DeepSeekPageSnapshot): Promise<void> {
    const ack = this.revivalAwaitingAck;
    if (!ack || !snapshot.conversationId || ack.conversationId !== snapshot.conversationId) return;
    const result = await bridge.ack(ack.id, this.owner, snapshot.conversationId).catch(() => null);
    if (!result) return;
    if (result.ok) {
      this.revivalAwaitingAck = null;
      this.noteRevivalHandled(ack.id);
      logInfo(`deepseek: worker wake ${ack.id} delivered in ${snapshot.conversationId}`);
      return;
    }
    if (!result.retryable) {
      logWarn(`deepseek: worker wake ${ack.id} could not be receipted — ${result.error ?? 'command refused'}`);
      this.revivalAwaitingAck = null;
      this.noteRevivalHandled(ack.id);
    }
  }

  /** Remembers this document's last few wakes without growing for a long-lived page. */
  private noteRevivalHandled(id: string): void {
    if (this.handledRevivals.size >= 32) {
      const oldest = this.handledRevivals.values().next().value;
      if (oldest) this.handledRevivals.delete(oldest);
    }
    this.handledRevivals.add(id);
    if (this.revivalOpening?.id === id) this.revivalOpening = null;
  }

  /** Fails one wake on its exact bridge row, never on a guessed worker identity. */
  private async failRevival(id: string, reason: string): Promise<void> {
    this.noteRevivalHandled(id);
    await workerBridge?.failRevival?.(id, this.owner, reason).catch(() => null);
  }

  /** Fails one worker command on its exact bridge row, never on a guessed agent identity. */
  private async failWorkerCommand(id: string, reason: string): Promise<void> {
    if (!workerBridge) return;
    const claimed = await workerBridge.claim(id, this.owner).catch(() => null);
    if (!claimed || !claimed.ok) return;
    const result = await workerBridge.ack(id, this.owner, null, reason).catch(() => null);
    if (!result || result.ok || !result.retryable) {
      this.workerOpening = null;
      this.awaitingWorker = null;
    }
  }

  private async observe(snapshot: DeepSeekPageSnapshot): Promise<void> {
    const now = Date.now();
    const epoch = this.navigationEpoch;
    this.adoptConversation(snapshot.conversationId, now);
    const last = snapshot.messages.at(-1);
    const lastText = last ? `${last.role}:${last.text}` : '';
    const changed = lastText !== this.state.lastText;
    const presentationChanged = last?.renderedHtml !== this.state.previous?.messages.at(-1)?.renderedHtml;
    if (changed) {
      this.state.lastText = lastText;
      this.state.changedAt = now;
      this.state.finalSent = false;
    }
    // DeepSeek often starts its answer before a poll sees the new question as the last row, so a
    // newer question anywhere in the page also ends the stop: otherwise that answer would count
    // as cut off and its tools would never run.
    if (this.state.stopped && this.state.stoppedQuestion !== null) {
      const question = lastQuestion(snapshot.messages);
      if (question !== null && question !== this.state.stoppedQuestion) this.state.stopped = false;
    }
    this.noteActivity(snapshot.conversationId, snapshot.busy || (changed && last?.role === 'assistant'), now);

    // A streaming answer is refreshed only when it changed; a finished one is recorded once
    // even though its last revision changed nothing.
    // The DOM only nominates a candidate. Raw history owns both its text and completion;
    // a slow stream or DeepThink pause must not turn a partial envelope into a final answer.
    const settled = !changed && !snapshot.busy && !!last && last.role === 'assistant' && now - this.state.changedAt >= SETTLE_MS;
    let emitFinal = settled && !this.state.finalSent;
    let finalText = last?.text ?? '';
    let finalFormat: FinalJob['textFormat'] = 'plain';
    let incomplete = this.state.stopped;
    if (emitFinal && snapshot.conversationId) {
      if (now < this.state.nextHistoryCheckAt) {
        emitFinal = false;
      } else {
        this.state.nextHistoryCheckAt = now + HISTORY_CHECK_MS;
        const history = await this.evaluate<DeepSeekHistoryResult>(deepSeekHistoryScript(snapshot.conversationId));
        if (!this.currentPage(epoch, snapshot.url)) return;
        if (history?.ok) {
          // Only a reply still being written blocks: FINISHED, INCOMPLETE (stopped/cut off) and any
          // other terminal status end the turn, or a stopped answer would hold the chat forever.
          emitFinal = history.role === 'ASSISTANT' && history.status !== 'WIP' && !history.pending;
          finalText = history.text;
          finalFormat = 'markdown';
          // Anything but FINISHED (INCOMPLETE: stopped or cut off) ends the turn without running
          // the tools a partial answer may name.
          if (history.status !== 'FINISHED') incomplete = true;
        } else if (!this.historyWarnings.has(snapshot.conversationId)) {
          this.historyWarnings.add(snapshot.conversationId);
          logWarn(`deepseek: raw history unavailable for ${snapshot.conversationId} — ${history?.reason ?? 'page-read-failed'}; using DOM text`);
        }
      }
    }
    if (last?.role === 'assistant' && !this.state.finalSent) {
      logInfo(`deepseek observe: changed=${changed} busy=${snapshot.busy} age=${now - this.state.changedAt} settled=${settled} len=${last.text.length}`);
    }
    const streaming = (changed || presentationChanged) && !settled && last?.role === 'assistant';
    if (!streaming && !emitFinal && !changed && !presentationChanged) {
      this.state.previous = snapshot;
      return;
    }

    const session = snapshot.conversationId
      ? await findSessionByConversation(snapshot.conversationId, { requireUnique: true }) : null;
    if (!this.currentPage(epoch, snapshot.url)) return;
    // A tool proposal is an intermediate response in the same local turn, including a refused
    // proposal that needs correction. Only a complete answer (or a confirmed Stop) ends it.
    const intermediate = emitFinal && !incomplete && parseDeepSeekReply(finalText, new Set()).kind !== 'text';
    const observations = deepSeekObservations(this.state.previous, snapshot, now, emitFinal, {
      activeTurnId: session?.activeTurnId ?? (this.state.stopped ? this.state.stoppedTurnId : null),
      intermediate,
      live: snapshot.busy || intermediate,
      ...(incomplete ? { outcome: this.state.stopped ? 'stopped' as const : 'interrupted' as const } : {})
    });
    // Derive identities from the original snapshot even without a row key. Only the final
    // observation's text changes; raw Markdown must not create a second history identity.
    const messageId = snapshot.conversationId
      ? deepSeekMessageIdAt(snapshot.conversationId, snapshot.messages, snapshot.messages.length - 1) : undefined;
    if (emitFinal) {
      const answer = observations.find(item => item.kind === 'assistant_message' && item.messageId === messageId);
      if (answer) { answer.text = finalText; answer.textFormat = finalFormat; }
    }
    this.state.previous = snapshot;
    if (!observations.length || !snapshot.conversationId) {
      if (emitFinal) this.state.finalSent = true;
      return;
    }
    if (!emitFinal) {
      await this.record(snapshot.conversationId, observations).catch(err =>
        logWarn(`deepseek: page observations were rejected — ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    // The finished answer is in this driver's custody until it is recorded and handed to the
    // reply path: a failure is retried, never dropped with the turn left hanging. The latch
    // only stops the same answer being emitted twice while custody runs.
    this.state.finalSent = true;
    const job: FinalJob = {
      conversationId: snapshot.conversationId,
      observations,
      text: finalText,
      textFormat: finalFormat,
      messageId: messageId ?? `ds:${snapshot.conversationId}:assistant:${Date.now()}`,
      turnId: observations.find(item => item.kind === 'assistant_message' && item.messageId === messageId)?.turnId,
      incomplete,
      // A finished answer is also the only place a tool request can arrive.
      deliver: last?.role === 'assistant' && this.currentPage(epoch, snapshot.url),
      recorded: false,
      sessionId: null
    };
    this.custodies += 1;
    await this.recordFinal(job).catch(err =>
      logWarn(`deepseek: page observations were rejected — ${err instanceof Error ? err.message : String(err)}`));
    void this.keepCustody(job).finally(() => { this.custodies -= 1; });
  }

  /** A different conversation starts from a clean turn state; the same one keeps its own. */
  private adoptConversation(conversationId: string | null, now = Date.now()): void {
    if (conversationId === this.state.conversationId) return;
    this.state = { previous: null, conversationId, lastText: '', changedAt: now, finalSent: false, stopped: false, stoppedQuestion: null, stoppedTurnId: null, nextHistoryCheckAt: 0, generating: false, activityAt: 0, sending: false };
  }

  /**
   * Tells the broker this chat's turn is running. A worker thinking or writing without a tool
   * call is still working; without this the silence sweep would put it to sleep mid-answer.
   */
  private noteActivity(conversationId: string | null, generating: boolean, now: number): void {
    if (!conversationId || !workerBridge?.noteActivity) return;
    if (generating === this.state.generating && (!generating || now - this.state.activityAt < ACTIVITY_MS)) return;
    this.state.generating = generating;
    this.state.activityAt = now;
    void workerBridge.noteActivity(conversationId, generating).catch(err =>
      logWarn(`deepseek: activity for ${conversationId} was not noted — ${err instanceof Error ? err.message : String(err)}`));
  }

  private async recordFinal(job: FinalJob): Promise<void> {
    if (job.recorded) return;
    const result = await this.record(job.conversationId, job.observations);
    job.sessionId = result?.sessionId ?? null;
    job.recorded = true;
  }

  /**
   * Records and hands over one finished answer, retrying with backoff. The reply path is
   * idempotent per message and keeps a computed continuation, so a retry never runs a tool twice.
   * When the retries run out the chat says so and the turn is released.
   */
  private async keepCustody(job: FinalJob): Promise<void> {
    for (let attempt = 0; attempt <= CUSTODY_RETRY_MS.length; attempt += 1) {
      if (attempt > 0) await sleep(CUSTODY_RETRY_MS[attempt - 1]!);
      try {
        await this.recordFinal(job);
        if (job.incomplete) {
          await this.noteIncomplete(job);
          return;
        }
        if (!job.deliver) return;
        const result = await deliverDeepSeekReply({ conversationId: job.conversationId, text: job.text, textFormat: job.textFormat, messageId: job.messageId, turnId: job.turnId, final: true });
        logInfo(`deepseek reply ${job.conversationId}: ${result.status} ${JSON.stringify(result.body)}`);
        if (result.status !== 503) return;
      } catch (err) {
        logWarn(`deepseek: reply for ${job.conversationId} failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    logWarn(`deepseek: gave up handing over the reply in ${job.conversationId} after ${CUSTODY_RETRY_MS.length + 1} tries`);
    const sessionId = await this.sessionFor(job.conversationId, job.sessionId);
    if (job.turnId) await this.record(job.conversationId, [{ kind: 'turn_end', time: Date.now(), turnId: job.turnId, outcome: 'stalled' }]).catch(() => undefined);
    if (sessionId) await recordNote(sessionId, mainText("This reply's results could not be saved after several tries. Send a message to continue.")).catch(() => undefined);
  }

  private async noteIncomplete(job: FinalJob): Promise<void> {
    logInfo(`deepseek: reply in ${job.conversationId} ended incomplete; no tools run, no continuation`);
    if (!TOOL_ENVELOPE.test(job.text)) return;
    const sessionId = await this.sessionFor(job.conversationId, job.sessionId);
    if (sessionId) await recordNote(sessionId, mainText('This reply was cut off before it finished, so its tool requests were not run.')).catch(() => undefined);
  }

  private async sessionFor(conversationId: string, known: string | null): Promise<string | null> {
    if (known) return known;
    return (await findSessionByConversation(conversationId, { requireUnique: true }).catch(() => null))?.id ?? null;
  }

  /**
   * Carries a Stop the person asked for into this page: clicks DeepSeek's own Stop, waits for
   * the generation to end, and answers the bridge's command. Whatever the page does, the turn is
   * stopped here: its answer is recorded but never runs tools or continues.
   */
  private async carryStop(snapshot: DeepSeekPageSnapshot): Promise<void> {
    const bridge = workerBridge;
    const conversationId = snapshot.conversationId;
    const epoch = this.navigationEpoch;
    if (!bridge?.claimPendingStop || !bridge.ackStop || !conversationId) return;
    const claimed = await bridge.claimPendingStop(conversationId, this.owner).catch(() => null);
    if (!claimed?.ok || !this.currentPage(epoch, snapshot.url)) return;
    this.adoptConversation(conversationId);
    this.state.stopped = true;
    this.state.stoppedQuestion = lastQuestion(snapshot.messages);
    this.state.stoppedTurnId = claimed.turnId;
    let clicked = false;
    let ended = !snapshot.busy;
    if (snapshot.busy) {
      clicked = (await this.evaluate<{ clicked: boolean }>(DEEPSEEK_STOP_SCRIPT))?.clicked === true;
      if (clicked) ended = await this.waitForIdle(STOP_CONFIRM_MS, epoch, snapshot.url);
    }
    if (!this.currentPage(epoch, snapshot.url)) return;
    if (!ended) {
      logWarn(`deepseek: Stop in ${conversationId} ${clicked ? 'was clicked but the page kept writing' : 'found no Stop control'}`);
      const sessionId = await this.sessionFor(conversationId, null);
      if (sessionId) await recordNote(sessionId, mainText("DeepSeek's Stop button did not respond; the rest of this reply is ignored.")).catch(() => undefined);
    }
    if (ended) await this.record(conversationId, [{ kind: 'turn_end', time: Date.now(), turnId: claimed.turnId, outcome: 'stopped' }]);
    const ack = await bridge.ackStop(claimed.id, this.owner, conversationId, claimed.turnId, ended,
      ended ? undefined : clicked ? 'native_stop_unconfirmed' : 'native_stop_unavailable').catch(() => null);
    if (!ack?.ok) logWarn(`deepseek: Stop receipt for ${conversationId} was not stored — ${ack?.error ?? 'bridge unavailable'}`);
  }

  private async waitForIdle(timeoutMs: number, epoch: number, url: string): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await sleep(STOP_POLL_MS);
      if (!this.currentPage(epoch, url)) return false;
      const after = await this.evaluate<DeepSeekPageSnapshot>(DEEPSEEK_SNAPSHOT_SCRIPT);
      if (!this.currentPage(epoch, url)) return false;
      if (after && !after.busy) return true;
    }
    return false;
  }

  private currentPage(epoch: number, url: string): boolean {
    return !this.disposed && !this.contents.isDestroyed() && this.navigationEpoch === epoch && this.contents.getURL() === url;
  }

  /**
   * DeepSeek's web composer has no native file attachment path this app owns. A message whose
   * files cannot travel must fail visibly, never go out as text that silently drops them.
   */
  private async onlyText(id: string, claimed: { attachments?: readonly unknown[]; images?: readonly unknown[] }): Promise<boolean> {
    if (!claimed.attachments?.length && !claimed.images?.length) return true;
    await failBrowserInput(id, this.owner, 'DeepSeek Web does not accept file attachments from this app yet. Send the files in the DeepSeek page, or remove them from this message.', 'attachments')
      .catch(() => false);
    return false;
  }

  /**
   * Types the first message of a new chat. The marker in the page's URL names exactly one
   * outbox row. An unmarked page may continue its own already-claimed send, but cannot
   * acquire one: being the only waiting row proves nothing about which page owns it.
   */
  private async deliverOpening(snapshot: DeepSeekPageSnapshot): Promise<void> {
    if (this.state.sending || snapshot.commandMarker) return;
    // The page moved to another row before this one was sent: fail the exact old row rather
    // than typing it into a page that names a different message.
    if (this.openingSend && snapshot.inputMarker && this.openingSend.id !== snapshot.inputMarker) {
      const stale = this.openingSend;
      this.openingSend = null;
      await failBrowserInput(stale.id, this.owner, 'The page changed to another message', 'wrong-page').catch(() => false);
    }
    let opening = this.openingSend;
    if (!opening) {
      if (!snapshot.inputMarker) return;
      const pending = await pendingBrowserInputs();
      const candidate = pending.find(row => row.id === snapshot.inputMarker && row.conversationId === null && row.lifetime !== 'temporary-planner');
      if (!candidate) return;
      const claimed = await claimBrowserInput(candidate.id, this.owner, null).catch(() => null);
      if (!claimed) return;
      if (!await this.onlyText(candidate.id, claimed)) return;
      opening = { id: candidate.id, text: claimed.text, model: claimed.model, reasoningEffort: claimed.reasoningEffort,
        sessionId: claimed.sessionId, since: Date.now(), retryAt: 0 };
      this.openingSend = opening;
    }
    // A composer that was briefly unavailable needs a settle window; the wake path uses the
    // same rule so a page that already took the message can paint its row before a retry.
    if (opening.retryAt > Date.now()) return;

    this.state.sending = true;
    try {
      const baseline = snapshot.messages.filter(message => message.role === 'user').length;
      const sent = await this.send(opening.text, opening, opening.sessionId);
      if (sent?.ok) {
        this.awaiting = { id: opening.id, owner: this.owner, text: opening.text, baseline, since: Date.now(), conversationId: null };
        this.openingSend = null;
        this.state.changedAt = Date.now();
        this.state.lastText = '';
        logInfo(`deepseek: sent new chat input ${opening.id}; waiting for its conversation`);
        return;
      }
      // Enter can submit the message while the composer stays busy long enough for the script to
      // report no send control. A page that now names a conversation or shows the row has taken
      // it; bind that exact row instead of failing a message the model may already be answering.
      const after = await this.evaluate<DeepSeekPageSnapshot>(DEEPSEEK_SNAPSHOT_SCRIPT);
      if (after?.conversationId || (after && matchingUserRows(after.messages, opening.text) > 0)) {
        this.awaiting = { id: opening.id, owner: this.owner, text: opening.text, baseline,
          since: Date.now(), conversationId: after?.conversationId ?? null };
        this.openingSend = null;
        this.state.changedAt = Date.now();
        this.state.lastText = '';
        logInfo(`deepseek: new chat input ${opening.id} reached ${after?.conversationId ?? 'the page'}`);
        return;
      }
      if (!sent) {
        opening.retryAt = Date.now() + SETTLE_MS;
        return;
      }
      if (Date.now() - opening.since < COMPOSER_WAIT_MS) {
        opening.retryAt = Date.now() + SETTLE_MS;
        logWarn(`deepseek: new chat input ${opening.id} not ready to send — ${sent.reason} ${JSON.stringify(sent.detail ?? {})}`);
        return;
      }
      this.openingSend = null;
      await failBrowserInput(opening.id, this.owner, 'DeepSeek did not accept the message', sent.reason || 'no-composer');
    } catch (err) {
      logWarn(`deepseek: opening delivery failed — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.state.sending = false;
    }
  }

  /** Binds a sent message to the conversation and user row the page finally shows. */
  private async bindAwaiting(snapshot: DeepSeekPageSnapshot): Promise<void> {
    // Required for a new chat: the question row is the only proof this conversation is ours.
    const awaiting = this.awaiting;
    if (!awaiting || !snapshot.conversationId) return;
    if (awaiting.conversationId && awaiting.conversationId !== snapshot.conversationId) {
      this.awaiting = null;
      await failBrowserInput(awaiting.id, awaiting.owner, 'DeepSeek opened a different conversation', 'wrong-conversation').catch(() => false);
      return;
    }
    const index = sentRowIndex(snapshot.messages, awaiting);
    // A new chat has no conversation id until its own question exists. Binding whatever
    // conversation first appears could attach the send to a chat the person opened meanwhile,
    // so that case requires the row itself, not the timeout. An existing chat already names
    // its conversation and may fall back to the id alone.
    if (index < 0 && (!awaiting.conversationId || Date.now() - awaiting.since < ACK_FALLBACK_MS)) return;
    const messageId = index >= 0 ? deepSeekMessageIdAt(snapshot.conversationId, snapshot.messages, index) : undefined;
    const acked = await acknowledgeBrowserInput(awaiting.id, awaiting.owner, snapshot.conversationId, messageId).catch(() => false);
    if (!acked) logWarn(`deepseek: input ${awaiting.id} could not be acknowledged into ${snapshot.conversationId}`);
    else logInfo(`deepseek: input ${awaiting.id} bound to ${snapshot.conversationId}`);
    this.awaiting = null;
  }

  /**
   * Delivers one queued message to a chat that already has an id. It waits for the answer on
   * screen to settle so an app continuation cannot interleave with a page that is still writing.
   */
  private async deliver(snapshot: DeepSeekPageSnapshot): Promise<boolean> {
    const epoch = this.navigationEpoch;
    if (!snapshot.conversationId || this.state.sending) return false;
    if (snapshot.busy || this.custodies > 0) return false;
    const last = snapshot.messages.at(-1);
    if (last?.role === 'assistant' && !this.state.finalSent) return false;

    const pending = (await pendingBrowserInputs()).find(row =>
      row.conversationId === snapshot.conversationId && row.lifetime !== 'temporary-planner');
    if (!pending || !this.currentPage(epoch, snapshot.url)) return false;

    this.state.sending = true;
    try {
      const claimed = await claimBrowserInput(pending.id, this.owner, snapshot.conversationId).catch(() => null);
      if (!claimed) return false;
      const withdraw = async () => {
        await failBrowserInput(pending.id, this.owner, SEND_WITHDRAWN, 'navigation').catch(() => false);
        return false;
      };
      if (!this.currentPage(epoch, snapshot.url)) return await withdraw();
      if (!await this.onlyText(pending.id, claimed)) return false;
      if (!this.currentPage(epoch, snapshot.url)) return await withdraw();
      if (claimed.deepSeekContinuation && !await authorizeBrowserInput(pending.id, this.owner, snapshot.conversationId)) return false;
      if (!this.currentPage(epoch, snapshot.url)) return await withdraw();
      const sent = await this.send(claimed.text, claimed, claimed.sessionId, snapshot.conversationId);
      if (sent?.withdrawn) return await withdraw();
      if (!sent?.ok) {
        await failBrowserInput(pending.id, this.owner, 'DeepSeek did not accept the message', sent?.reason ?? 'no-composer');
        return false;
      }
      // Not acknowledged until the page shows the question: that row is the receipt, and its
      // exact id keeps the delivered history and the page observation one message.
      this.awaiting = {
        id: pending.id,
        owner: this.owner,
        text: claimed.text,
        baseline: snapshot.messages.filter(message => message.role === 'user').length,
        since: Date.now(),
        conversationId: snapshot.conversationId
      };
      this.state.changedAt = Date.now();
      this.state.lastText = '';
      logInfo(`deepseek: sent input ${pending.id} into ${snapshot.conversationId}; waiting for its question row`);
      return true;
    } catch (err) {
      logWarn(`deepseek: input delivery failed — ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.state.sending = false;
    }
  }
}

/**
 * Attaches a driver to one web contents, following it across navigations. Safe for every
 * window the app creates: a document outside chat.deepseek.com is simply ignored.
 */
export function attachDeepSeekPageDriver(contents: WebContents): void {
  const driver = new DeepSeekPageDriver(contents);
  const sync = (): void => {
    // A helper chat's hidden window is the app's own question, never the person's conversation.
    if (isDeepSeekHelperContents(contents)) return driver.stop();
    if (isDeepSeekUrl(contents.getURL())) driver.start();
  };
  contents.on('did-navigate', sync);
  contents.on('did-navigate-in-page', sync);
  contents.on('did-finish-load', sync);
  contents.once('destroyed', () => driver.stop());
  sync();
}

/** The person's latest question in the page, with its stable list key when DeepSeek renders one. */
function lastQuestion(messages: DeepSeekPageMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'user') return `${message.key ?? ''}:${message.text}`;
  }
  return null;
}
