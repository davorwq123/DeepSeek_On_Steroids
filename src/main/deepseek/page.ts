/**
 * Reading and driving a DeepSeek conversation page.
 *
 * The selectors below were taken from a real DeepSeek conversation document, not guessed:
 * every message row is `.ds-message`; an answer is the row's own
 * `.ds-assistant-message-main-content` (reasoning lives in a sibling `.ds-think-content`, so it
 * is never mistaken for the answer); a question is the row's `.ds-collapsible-text` bubble.
 * The composer is the page's only `<textarea>`, and Enter submits it.
 *
 * Everything here is a plain string or a pure function: the scripts run in the page through
 * `executeJavaScript`, and the diff runs in the app so it can be tested without a browser.
 */

import { createHash } from 'node:crypto';
import { deepSeekThinkingEffort, isDeepSeekModel } from '../../shared/chat-models.js';
import { DEEPSEEK_SIGNED_IN_CHECK } from '../cos-browser/sign-in.js';
import type { ChatObservation } from '../session/recorder.js';
import { parseDeepSeekReply } from './tool-protocol.js';

export interface DeepSeekPageMessage {
  role: 'user' | 'assistant';
  text: string;
  /** The exact assistant DOM revision whose visible text this row carries. */
  renderedHtml?: string;
  /** DeepSeek's virtual-list item key; an absolute, stable position in this conversation. */
  key?: string | null;
}

export interface DeepSeekPageSnapshot {
  url: string;
  conversationId: string | null;
  /** The exact outbox row the app opened this new-chat page for, if any. */
  inputMarker: string | null;
  /** The exact broker worker bootstrap (`clf`) this page was opened for, if any. */
  commandMarker: string | null;
  signedIn: boolean;
  /** The signed-in page has mounted an enabled composer, rather than only restored its token. */
  composerReady?: boolean;
  busy: boolean;
  /** DeepSeek is refusing more messages until its short rate-limit window clears. */
  throttled: boolean;
  messages: DeepSeekPageMessage[];
}

export type DeepSeekHistoryResult =
  | { ok: true; messageId: number; role: 'USER' | 'ASSISTANT'; status: string; pending: boolean; text: string }
  | { ok: false; reason: string };

/** Raw fragments and completion evidence for the active branch, never rendered Markdown. */
export function deepSeekHistoryScript(conversationId: string): string {
  return `(async () => {
  try {
    const token = JSON.parse(localStorage.getItem('userToken') || 'null')?.value;
    if (typeof token !== 'string' || !token) return { ok: false, reason: 'no-token' };
    const response = await fetch('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(${JSON.stringify(conversationId)}), {
      method: 'GET', credentials: 'include', headers: { Authorization: 'Bearer ' + token }
    });
    if (!response.ok) return { ok: false, reason: 'http-error' };
    const body = await response.json();
    const data = body?.data;
    const history = data?.biz_data;
    if (body?.code !== 0 || data?.biz_code !== 0 || !history) return { ok: false, reason: 'invalid-history' };
    const session = history.chat_session;
    const messages = history.chat_messages;
    if (session?.id !== ${JSON.stringify(conversationId)} || !Array.isArray(messages) || !messages.length ||
        messages.some(message => !Number.isSafeInteger(message?.message_id))) return { ok: false, reason: 'invalid-messages' };
    const currentId = session.current_message_id;
    const active = currentId == null
      ? messages.reduce((latest, message) => message.message_id > latest.message_id ? message : latest)
      : messages.find(message => message.message_id === currentId);
    if (!active || !['USER', 'ASSISTANT'].includes(active.role) || typeof active.status !== 'string' || !active.status ||
        typeof active.has_pending_fragment !== 'boolean' || !Array.isArray(active.fragments) ||
        active.fragments.some(fragment => typeof fragment?.type !== 'string' ||
          (fragment.type === 'RESPONSE' && typeof fragment.content !== 'string'))) return { ok: false, reason: 'invalid-message' };
    return { ok: true, messageId: active.message_id, role: active.role, status: active.status,
      pending: active.has_pending_fragment,
      text: active.fragments.filter(fragment => fragment.type === 'RESPONSE').map(fragment => fragment.content).join('') };
  } catch { return { ok: false, reason: 'history-unavailable' }; }
})()`;
}

/**
 * The page's own Stop controls, visible ones only: a stop/停止/中止 label, or the composer's
 * filled stop-square icon. An expression evaluating to an array; it needs a `visible` helper in
 * scope. Shared by the snapshot's `busy` hint and the Stop click so the two never disagree.
 */
const STOP_CONTROLS_JS = `(() => {
  let composer = document.querySelector('textarea')?.parentElement;
  while (composer && composer !== document.body && !composer.querySelector('button, [role="button"]')) composer = composer.parentElement;
  const stopSquare = (button) => {
    const shapes = button.querySelectorAll('svg rect, svg path, svg polygon');
    if (shapes.length !== 1) return false;
    const shape = shapes[0];
    const fill = getComputedStyle(shape).fill;
    if (!visible(shape) || fill === 'none' || fill === 'transparent' || (fill.startsWith('rgba(') && fill.endsWith(', 0)'))) return false;
    if (shape.tagName.toLowerCase() === 'rect') {
      const width = Number(shape.getAttribute('width'));
      const height = Number(shape.getAttribute('height'));
      return width > 0 && width === height;
    }
    try {
      // A filled, nearly square outline with a square's perimeter also covers DeepSeek's
      // rounded-square path, without mistaking a circle, arrow or plus icon for Stop.
      const box = shape.getBBox();
      const length = shape.getTotalLength();
      return box.width > 0 && Math.abs(box.width - box.height) < box.width * 0.1 &&
        length >= box.width * 3.4 && length <= box.width * 4.1;
    } catch { return false; }
  };
  const labelled = Array.from(document.querySelectorAll('[aria-label], [title]')).filter((el) =>
    visible(el) && !el.closest('.ds-message') &&
    /stop|停止|中止/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')));
  const squares = composer && composer !== document.body && !composer.querySelector('.ds-message, .ds-virtual-list')
    ? Array.from(composer.querySelectorAll('button, [role="button"]')).filter((el) => visible(el) && stopSquare(el)) : [];
  return [...labelled, ...squares];
})()`;

/** Clicks the page's own Stop control. Returns `{ clicked }`; never guesses a hashed class name. */
export const DEEPSEEK_STOP_SCRIPT = `(() => {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const controls = ${STOP_CONTROLS_JS};
  const target = controls[0];
  if (!target) return { clicked: false };
  const button = target.closest('button, [role="button"]') || target;
  button.click();
  return { clicked: true };
})()`;

/**
 * One synchronous read of the page. Returns `DeepSeekPageSnapshot`.
 *
 * `busy` recognizes a visible stop label or the composer's stop-square icon. It is only a
 * hint; raw history owns the completion evidence whenever it is available.
 */
export const DEEPSEEK_SNAPSHOT_SCRIPT = `(() => {
  const path = location.pathname;
  const patterns = [/^\\/a\\/chat\\/s\\/([A-Za-z0-9-]{8,128})\\/?$/, /^\\/chat\\/s\\/([A-Za-z0-9-]{8,128})\\/?$/, /^\\/s\\/([A-Za-z0-9-]{8,128})\\/?$/];
  let conversationId = null;
  for (const pattern of patterns) {
    const match = pattern.exec(path);
    if (match) { conversationId = match[1]; break; }
  }
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const clean = (value) => String(value || '').replace(/\\r\\n/g, '\\n').trim();
  const messages = [];
  for (const row of Array.from(document.querySelectorAll('.ds-message'))) {
    const item = row.closest('[data-virtual-list-item-key]');
    const key = item?.getAttribute('data-virtual-list-item-key') || null;
    const answer = row.querySelector('.ds-assistant-message-main-content');
    if (answer) {
      const text = clean(answer.innerText ?? answer.textContent);
      const html = answer.innerHTML;
      // Bound markup before crossing into main; an incomplete HTML prefix is not a capture.
      if (text) messages.push({ role: 'assistant', text, key, ...(html.length <= 120_000 ? { renderedHtml: html } : {}) });
      continue;
    }
    const bubble = row.querySelector('.ds-collapsible-text') || row.querySelector('.fbb737a4');
    // A message wrapper can hold native search/thinking/status chrome before an answer
    // mounts. No assistant body does not prove a user: require the actual question bubble.
    if (!bubble) continue;
    const text = clean(bubble.innerText ?? bubble.textContent);
    if (text) messages.push({ role: 'user', text, key });
  }
  const busy = ${STOP_CONTROLS_JS}.length > 0;
  // A rate-limit banner is page chrome, not an answer. Match only visible leaf nodes outside
  // the transcript, so an assistant discussing the phrase can never pause its own run.
  const throttled = Array.from(document.querySelectorAll('span, p, div')).some((el) => {
    if (el.children.length || !visible(el) || el.closest('.ds-message')) return false;
    return /Messages too frequent|(?:发送|请求|操作)(?:过于|太)频繁/i.test((el.textContent || '').trim());
  });
  const inputMarker = new URLSearchParams(location.search).get('cos-input') ||
    new URLSearchParams(location.hash.slice(1)).get('cos-input');
  const commandMarker = new URLSearchParams(location.search).get('clf') ||
    new URLSearchParams(location.hash.slice(1)).get('clf');
  return {
    url: location.href,
    conversationId,
    inputMarker,
    commandMarker,
    signedIn: ${DEEPSEEK_SIGNED_IN_CHECK},
    composerReady: !!document.querySelector('textarea:not(:disabled)'),
    busy,
    throttled,
    messages
  };
})()`;

/**
 * Type one message into the composer and submit it.
 *
 * DeepSeek's textarea is React-controlled, so the value goes through the native setter and a
 * real input event; Enter then submits exactly as it does for a person. If Enter did not clear
 * the box (a different build, an IME focus), the page's own send control is clicked instead.
 */
export type DeepSeekSendSelection = { model?: string | null; reasoningEffort?: string | null };
export type DeepSeekSendResult = {
  ok: boolean;
  reason: string;
  /** Proven withdrawal before any native Enter or Send attempt. */
  withdrawn?: boolean;
  detail?: unknown;
  warnings?: string[];
  deepThink?: boolean;
};

/** Visible DeepThink toggles on the page, outside the transcript. Shared by sending and probing. */
// DeepSeek draws DeepThink and Search as `div.ds-toggle-button[aria-pressed]`, not as buttons.
const DEEPTHINK_FIND = `
    const findDeepThink = () => {
      const label = /^(?:DeepThink|深度思考)$/i;
      const matches = Array.from(document.querySelectorAll('button, .ds-toggle-button, [role="button"], [role="tab"], [role="radio"], [role="switch"]')).filter((el) => {
        if (el.closest('[hidden], [aria-hidden="true"], .ds-message')) return false;
        for (let node = el; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return [el.textContent, el.getAttribute('aria-label')].some((text) => label.test(String(text || '').trim()));
      });
      return matches.length === 1 ? matches[0] : null;
    };`;

/** Whether the page shows a DeepThink toggle right now: true, false, or null with no composer yet. */
export function deepSeekDeepThinkProbeScript(): string {
  return `(() => {${DEEPTHINK_FIND}
    if (!document.querySelector('textarea')) return null;
    return !!findDeepThink();
  })()`;
}

export function deepSeekSendScript(text: string, selection?: DeepSeekSendSelection, expectedUrl?: string): string {
  // DeepSeek's web chat has one model since September 2026; its only composer choice is the
  // DeepThink toggle. A missing toggle leaves the send usable but cannot confirm that request.
  const drive = !!selection?.model && isDeepSeekModel(selection.model);
  const thinking = selection?.reasoningEffort ? deepSeekThinkingEffort(selection.reasoningEffort) === 'high' : false;
  return `(async () => {
  // Layout answers on a real page; a page without layout (a test document, or a window Chromium
  // has not painted yet) still has exactly one composer, and it is neither hidden nor disabled.
  const usable = (el) => !!el && (el.getClientRects().length > 0 || (!el.closest('[hidden]') && !el.disabled));
  const warnings = [];
  let deepThink;
  // This send owns this navigation only. A URL comparison alone misses A -> B -> A while
  // the model control or Send is settling. Chromium's native event also covers SPA moves.
  const url = ${JSON.stringify(expectedUrl) ?? 'location.href'};
  let navigated = false;
  let submitted = false;
  const abandon = () => { navigated = true; };
  const current = () => !navigated && location.href === url;
  const withdrawn = () => ({ ok: false, reason: 'navigation', withdrawn: !submitted, warnings, deepThink });
  const navigation = window.navigation;
  navigation?.addEventListener('navigate', abandon);
  try {
  if (!current()) return withdrawn();
  let box = Array.from(document.querySelectorAll('textarea')).find(usable);
  if (!box) return { ok: false, reason: 'no-composer' };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (${drive}) {${DEEPTHINK_FIND}
    const state = (el) => {
      if (!el) return null;
      for (const node of [el, el.parentElement]) {
        if (!node) continue;
        for (const attr of ['aria-pressed', 'aria-checked', 'aria-selected']) {
          const value = node.getAttribute(attr);
          if (value === 'true') return true;
          if (value === 'false') return false;
        }
        if (Array.from(node.classList).some((token) => /(?:^|[-_])(?:active|selected|checked)(?:$|[-_])/i.test(token))) return true;
      }
      // With class-based toggles, absence of the active marker means off. An unmarked
      // element with no readable state remains unknown rather than blindly toggling it.
      return el.classList.length || el.parentElement?.classList.length ? false : null;
    };
    const control = findDeepThink();
    deepThink = !!control;
    if (control) {
      const before = state(control);
      if (before === null) warnings.push('DeepThink');
      else if (before !== ${thinking}) {
        try { control.click(); } catch { warnings.push('DeepThink'); }
        if (!warnings.length) {
          let confirmed = false;
          for (let attempt = 0; attempt < 8 && !confirmed; attempt += 1) {
            if (!current()) return withdrawn();
            confirmed = state(findDeepThink()) === ${thinking};
            if (!confirmed) await wait(50);
          }
          if (!confirmed) warnings.push('DeepThink');
        }
      }
    } else warnings.push('DeepThink');
    // Toggling can replace React's composer. Type only into the newly mounted box.
    if (!current()) return withdrawn();
    box = Array.from(document.querySelectorAll('textarea')).find(usable);
    if (!box) return { ok: false, reason: 'no-composer', warnings, deepThink };
  }
  if (!current()) return withdrawn();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  box.focus();
  if (!current()) return withdrawn();
  // A previous send attempt can leave the exact wake in the composer when its control was
  // briefly unavailable. Keep it, rather than retyping and risking a second submission.
  if (String(box.value || '').trim() !== ${JSON.stringify(text)}.trim()) {
    if (setter) setter.call(box, ${JSON.stringify(text)}); else box.value = ${JSON.stringify(text)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (!current()) return withdrawn();
  const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  submitted = true;
  box.dispatchEvent(new KeyboardEvent('keydown', enter));
  if (current()) box.dispatchEvent(new KeyboardEvent('keypress', enter));
  if (current()) box.dispatchEvent(new KeyboardEvent('keyup', enter));
  const cleared = () => !String(box.value || '').trim();
  // The page enables its send control only after React has taken the input event; a fast
  // Enter can land while the control is still disabled, so give both paths a short window.
  for (let i = 0; i < 10 && !cleared(); i += 1) {
    if (!current()) return withdrawn();
    await wait(100);
  }
  if (cleared()) return { ok: true, reason: 'enter', warnings, deepThink };
  if (!current()) return withdrawn();
  // DeepSeek's send control is a primary circular button with no label or title; its only
  // other primary-looking control is the attachment capsule ('ds-button--iconLabelPrimary').
  const sendControl = () => Array.from(document.querySelectorAll('button, [role="button"]')).filter(usable).find((el) => {
    const cls = String(el.className);
    return el.classList.contains('ds-button--primary') && !el.closest('.ds-message') &&
      !/disabled/.test(cls) && el.getAttribute('aria-disabled') !== 'true';
  });
  let button = null;
  for (let i = 0; i < 20 && !button; i += 1) {
    if (!current()) return withdrawn();
    button = sendControl() || null;
    if (!button) await wait(100);
  }
  if (!current()) return withdrawn();
  if (button) {
    button.click();
    for (let i = 0; i < 10 && !cleared(); i += 1) {
      if (!current()) return withdrawn();
      await wait(100);
    }
  }
  return { ok: cleared(), reason: button ? 'button' : 'no-send-control', warnings, deepThink, detail: {
    valueLength: String(box.value || '').length, readyState: document.readyState,
    textareas: document.querySelectorAll('textarea').length, rects: box.getClientRects().length,
    primaryControls: Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) =>
      el.classList.contains('ds-button--primary')).length
  } };
  } finally { navigation?.removeEventListener('navigate', abandon); }
})()`;
}

/**
 * Stable per-conversation message identity.
 *
 * DeepSeek renders no message ids and keeps only the visible window of the transcript in the
 * DOM, so a row's position in one snapshot changes as older rows scroll out. Its virtual list
 * does expose an absolute item key beside each row; that key is stable while an answer streams
 * and when the window moves. A DOM without it (older builds, fixtures) falls back to content:
 * an authored question and a finished answer never change, and the occurrence count separates
 * two genuinely identical rows while both are visible.
 */
export function deepSeekMessageId(
  conversationId: string,
  role: DeepSeekPageMessage['role'],
  text: string,
  occurrence = 0,
  key?: string | null
): string {
  if (key && /^[A-Za-z0-9_-]{1,128}$/.test(key)) return `ds:${conversationId}:${role}:row-${key}`;
  const digest = createHash('sha256').update(`${role}\u0000${text}\u0000${occurrence}`, 'utf8').digest('hex');
  return `ds:${conversationId}:${role}:${digest.slice(0, 20)}`;
}

/** The identity of one row in a whole snapshot, including its duplicate occurrence. */
export function deepSeekMessageIdAt(
  conversationId: string,
  messages: readonly DeepSeekPageMessage[],
  index: number
): string | undefined {
  const message = messages[index];
  if (!message) return undefined;
  let occurrence = 0;
  for (let earlier = 0; earlier < index; earlier += 1) {
    const row = messages[earlier]!;
    if (row.role === message.role && row.text === message.text) occurrence += 1;
  }
  return deepSeekMessageId(conversationId, message.role, message.text, occurrence, message.key);
}

/**
 * The local turn one question row owns.
 *
 * DeepSeek renders no turn ids, but a question row is an absolute position in its virtual list,
 * so a hash of the question's own message id is stable across polls, reloads and window shifts.
 * The question and its answer share it, which is what lets the recorder close exactly that turn.
 */
export function deepSeekTurnId(conversationId: string, messages: readonly DeepSeekPageMessage[], userIndex: number): string | undefined {
  const messageId = deepSeekMessageIdAt(conversationId, messages, userIndex);
  if (!messageId) return undefined;
  return `ds-turn:${createHash('sha256').update(messageId, 'utf8').digest('hex').slice(0, 20)}`;
}

/**
 * The transcript changes one poll produced, as recorder observations.
 *
 * Only changed rows are emitted. A streaming answer keeps one id from its virtual-list key, so
 * every revision updates the same message. On a DOM without that key, streaming would need a
 * new content identity per revision; those rows are recorded only once settled. Earlier
 * assistant rows in the same snapshot are already history.
 *
 * The live turn's lifecycle is part of the same batch: a question the page has just shown opens
 * it, and its settled answer closes it. Without those boundaries the recorder can never prove a
 * turn completed, and a tool result queued for the continuation waits forever.
 */
export function deepSeekObservations(
  previous: DeepSeekPageSnapshot | null,
  next: DeepSeekPageSnapshot,
  now: number,
  final = false,
  turn: { activeTurnId?: string | null; intermediate?: boolean; live?: boolean; outcome?: ChatObservation['outcome'] } = {}
): ChatObservation[] {
  if (!next.conversationId) return [];
  const sameConversation = !!previous && previous.conversationId === next.conversationId;
  const before = sameConversation ? previous.messages : [];
  let lastUserIndex = -1;
  for (let index = next.messages.length - 1; index >= 0; index -= 1) {
    if (next.messages[index]!.role === 'user') { lastUserIndex = index; break; }
  }
  const lastMessage = next.messages.at(-1);
  const question = lastUserIndex >= 0 ? next.messages[lastUserIndex]! : undefined;
  const earlierQuestion = lastUserIndex >= 0 ? before[lastUserIndex] : undefined;
  const questionIsNew = !!question && (!earlierQuestion || earlierQuestion.role !== 'user' || earlierQuestion.text !== question.text);
  // A page that first appears already showing its question and nothing else is the send this
  // driver just typed. Every other first snapshot is adopted history and opens no turn.
  const opensLiveTurn = !!question && (turn.live || (questionIsNew && (sameConversation || (previous === null && lastMessage === question))));
  // Provider questions carrying tool results belong to the existing local task. Only the
  // recorder's current turn may lend that identity; a browser round is not a new user task.
  const turnId = turn.activeTurnId ?? (question && lastUserIndex >= 0 ? deepSeekTurnId(next.conversationId, next.messages, lastUserIndex) : undefined);
  const observations: ChatObservation[] = [];
  for (let index = 0; index < next.messages.length; index += 1) {
    const message = next.messages[index]!;
    const earlier = before[index];
    const unchanged = earlier?.role === message.role && earlier.text === message.text && earlier.renderedHtml === message.renderedHtml;
    const lastAssistant = message.role === 'assistant' && index === next.messages.length - 1;
    if (message.role === 'user') {
      if (!unchanged) observations.push({
        kind: 'user_message',
        time: now,
        text: message.text,
        messageId: deepSeekMessageIdAt(next.conversationId, next.messages, index)
      });
      // Record the actual opening question before its start, so the recorder's native question
      // index and the timeline agree. Timestamp proximity cannot prove a user's turn owner.
      // The start is still needed when this question was already recorded in an earlier poll.
      if (index === lastUserIndex && opensLiveTurn && turnId && !turn.activeTurnId) {
        observations.push({ kind: 'turn_start', time: now, turnId });
      }
      continue;
    }
    // A final update is worth recording even though its text did not change: that is the
    // observation that tells the recorder the turn is over. The driver sends it once.
    if (unchanged && !(final && lastAssistant)) continue;
    // Without the virtual-list key there is no stable identity for a growing answer. Record
    // it once settled; a keyed answer updates one message through every revision.
    if (lastAssistant && !final && !message.key) continue;
    // A virtual list can bring an older tool round back into view. Its changed position
    // cannot promote an interim request into a final answer and close the current task.
    const intermediate = lastAssistant ? turn.intermediate : parseDeepSeekReply(message.text, new Set()).kind !== 'text';
    const settled = (!lastAssistant || final) && !intermediate;
    observations.push({
      kind: 'assistant_message',
      time: now,
      text: message.text,
      textFormat: 'plain',
      ...(message.renderedHtml ? { renderedHtml: message.renderedHtml } : {}),
      messageId: deepSeekMessageIdAt(next.conversationId, next.messages, index),
      ...(lastAssistant && turnId ? { turnId } : {}),
      final: settled,
      state: settled ? 'final' : 'streaming',
      providerRole: 'assistant',
      providerStatus: settled ? 'finished_successfully' : 'in_progress',
      ...(lastAssistant && turn.live ? { activeNow: true } : {})
    });
  }
  // Only a settled answer closes the turn it answered. Emitted last so the batch's own
  // assistant final is part of the turn the recorder closes.
  if (final && !turn.intermediate && lastMessage?.role === 'assistant' && turnId) {
    observations.push({ kind: 'turn_end', time: now, turnId, outcome: turn.outcome ?? 'completed' });
  }
  return observations;
}

/** True when the answer on screen has stopped changing for `settledFor` ms. */
export function answerSettled(
  previous: DeepSeekPageSnapshot | null,
  next: DeepSeekPageSnapshot,
  changedAt: number,
  now: number,
  settledFor = 1_500
): boolean {
  const before = previous?.messages ?? [];
  const last = next.messages.at(-1);
  if (!last || last.role !== 'assistant') return false;
  const earlier = before[before.length - 1];
  if (!earlier || earlier.role !== 'assistant' || earlier.text !== last.text) return false;
  return now - changedAt >= settledFor;
}
