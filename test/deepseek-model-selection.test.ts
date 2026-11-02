import { JSDOM } from 'jsdom';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pending: vi.fn(), claim: vi.fn(), warn: vi.fn(), note: vi.fn() }));
vi.mock('../src/main/session/input.js', () => ({ pendingBrowserInputs: mocks.pending, claimBrowserInput: mocks.claim,
  acknowledgeBrowserInput: vi.fn(async () => true), failBrowserInput: vi.fn() }));
vi.mock('../src/main/session/recorder.js', () => ({ recordChatObservations: vi.fn(async () => ({ sessionId: 'session-worker' })), recordNote: mocks.note }));
vi.mock('../src/main/session/store.js', () => ({ findSessionByConversation: vi.fn(async () => ({ id: 'session-worker' })) }));
vi.mock('../src/main/deepseek/reply.js', () => ({ deliverDeepSeekReply: vi.fn() }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: mocks.warn }));
const catalog = vi.hoisted(() => ({ deepThink: [] as boolean[] }));
vi.mock('../src/main/chat-models.js', () => ({ noteDeepThinkControl: (value: boolean) => { catalog.deepThink.push(value); } }));
import { DeepSeekPageDriver, setDeepSeekWorkerBridge } from '../src/main/deepseek/page-driver.js';

let dom: JSDOM;
let driver: DeepSeekPageDriver;
const conversation = 'a97f3e4c-de96-4fc4-ada0-123456789abc';
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); catalog.deepThink.length = 0; mocks.pending.mockResolvedValue([]); mocks.note.mockResolvedValue(undefined); });
afterEach(() => { driver?.stop(); dom?.window.close(); setDeepSeekWorkerBridge(null); vi.useRealTimers(); });

function setup(controls: string, selection: { model?: string | null; reasoningEffort?: string | null }, opening = false) {
  dom = new JSDOM(`<body><textarea></textarea>${controls}</body>`, {
    url: opening ? 'https://chat.deepseek.com/?cos-input=input-1' : `https://chat.deepseek.com/a/chat/s/${conversation}`, runScripts: 'outside-only'
  });
  dom.window.localStorage.setItem('userToken', JSON.stringify({ value: 'test-token' }));
  dom.window.setTimeout = setTimeout as unknown as typeof dom.window.setTimeout;
  const order: string[] = [];
  const box = dom.window.document.querySelector('textarea')!;
  box.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    order.push('send'); box.value = '';
  });
  for (const button of dom.window.document.querySelectorAll<HTMLButtonElement>('button')) {
    button.addEventListener('click', () => {
      expect(box.value).toBe('');
      order.push(button.id);
      if (button.dataset.stuck) return;
      if (button.id === 'think') button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
    });
  }
  const contents = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, getURL: () => dom.window.location.href,
    executeJavaScript: async (script: string) => dom.window.eval(script) });
  driver = new DeepSeekPageDriver(contents as any);
  mocks.pending.mockResolvedValueOnce([{ id: 'input-1', conversationId: opening ? null : conversation }]).mockResolvedValue([]);
  mocks.claim.mockResolvedValue({ id: 'input-1', sessionId: 'session-1', text: 'hello', ...selection });
  return order;
}
// The page as DeepSeek's builds have shown it: leftover mode buttons and, on some, DeepThink.
const controls = (think: boolean | null) => `
  <button id="instant" aria-pressed="true">Instant</button>
  <button id="expert" aria-pressed="false">Expert</button>
  ${think === null ? '' : `<button id="think" aria-pressed="${think}">DeepThink</button>`}`;
async function send() { driver.start(); await vi.advanceTimersByTimeAsync(2200); }

it.each([false, true])('turns DeepThink on before typing and never clicks a mode (new chat=%s)', async opening => {
  const order = setup(controls(false), { model: 'deepseek-flash', reasoningEffort: 'high' }, opening);
  await send();
  expect(order).toEqual(['think', 'send']);
  expect(mocks.warn).not.toHaveBeenCalled(); expect(mocks.note).not.toHaveBeenCalled();
  expect(catalog.deepThink).toContain(true);
});
it('turns DeepThink off, and leaves an already correct toggle untouched', async () => {
  expect(await (async () => { const order = setup(controls(true), { model: 'deepseek-flash', reasoningEffort: 'none' }); await send(); return order; })()).toEqual(['think', 'send']);
  driver.stop(); dom.window.close();
  expect(await (async () => { const order = setup(controls(true), { model: 'deepseek-flash', reasoningEffort: 'high' }); await send(); return order; })()).toEqual(['send']);
});
// DeepSeek's own markup (2026-11): plain divs with aria-pressed and a --selected class, no role.
it('drives DeepSeek\'s div toggle without a selection warning', async () => {
  const order = setup(`<div class="ds-toggle-button ds-toggle-button--m" aria-pressed="false" id="think"><span>DeepThink</span></div>
    <div class="ds-toggle-button ds-toggle-button--m ds-toggle-button--selected" aria-pressed="true" id="search"><span>Search</span></div>`,
  { model: 'deepseek-flash', reasoningEffort: 'high' });
  const think = dom.window.document.getElementById('think')!;
  think.addEventListener('click', () => { order.push('think'); think.setAttribute('aria-pressed', 'true'); think.classList.add('ds-toggle-button--selected'); });
  await send();
  expect(order).toEqual(['think', 'send']);
  expect(mocks.warn).not.toHaveBeenCalled(); expect(mocks.note).not.toHaveBeenCalled();
  expect(catalog.deepThink).toContain(true);
});
// Chats and settings saved while V4-Pro was offered still send, on the one model.
it('treats the retired V4-Pro id as the web model', async () => {
  const order = setup(controls(false), { model: 'deepseek-v4-pro', reasoningEffort: 'high' });
  await send(); expect(order).toEqual(['think', 'send']); expect(mocks.note).not.toHaveBeenCalled();
});
it.each([undefined, null])('Automatic touches no controls (model=%s)', async model => {
  const order = setup(controls(false), { model, reasoningEffort: 'high' });
  await send(); expect(order).toEqual(['send']); expect(mocks.warn).not.toHaveBeenCalled();
});
it.each(['none', 'high'])('sends with a visible selection warning when the requested thinking %s has no native toggle', async reasoningEffort => {
  const order = setup(controls(null), { model: 'deepseek-flash', reasoningEffort });
  await send(); expect(order).toEqual(['send']);
  expect(mocks.warn.mock.calls.filter(([message]) => message.includes('DeepThink'))).toHaveLength(1);
  expect(mocks.note).toHaveBeenCalledExactlyOnceWith('session-1', expect.stringContaining('DeepThink'));
  expect(catalog.deepThink).toContain(false);
  expect(catalog.deepThink).not.toContain(true);
});
it.each(['stuck', 'unknown'])('still sends and records one visible note when DeepThink is %s', async problem => {
  let html = controls(false);
  if (problem === 'stuck') html = html.replace('id="think"', 'id="think" data-stuck="true"');
  if (problem === 'unknown') html = html.replace(/ aria-pressed="(?:true|false)"/g, '');
  const order = setup(html, { model: 'deepseek-flash', reasoningEffort: 'high' });
  await send();
  expect(order.at(-1)).toBe('send');
  expect(mocks.warn.mock.calls.filter(([message]) => message.includes('DeepThink'))).toHaveLength(1);
  expect(mocks.note).toHaveBeenCalledWith('session-1', expect.stringContaining('DeepThink'));
});
it('ignores hidden and transcript controls with the same label', async () => {
  const order = setup(`<div style="display:none"><button id="hidden">DeepThink</button></div>
    <div class="ds-message"><button id="transcript">DeepThink</button></div>${controls(false)}`,
    { model: 'deepseek-flash', reasoningEffort: 'high' });
  await send(); expect(order).toEqual(['think', 'send']); expect(mocks.warn).not.toHaveBeenCalled();
});
it('types into the replacement composer after the toggle rerenders it', async () => {
  const order = setup(controls(false), { model: 'deepseek-flash', reasoningEffort: 'high' });
  dom.window.document.getElementById('think')!.addEventListener('click', () => {
    const replacement = dom.window.document.createElement('textarea');
    replacement.addEventListener('keydown', event => {
      if (event.key === 'Enter') { order.push('send'); expect(replacement.value).toBe('hello'); replacement.value = ''; }
    });
    dom.window.document.querySelector('textarea')!.replaceWith(replacement);
  });
  await send(); expect(order).toEqual(['think', 'send']); expect(mocks.warn).not.toHaveBeenCalled();
});
it('recognizes the Chinese label, an aria label and state on the parent', async () => {
  const order = setup(`<button id="think" aria-label="深度思考" aria-pressed="false"></button>`, { model: 'deepseek-flash', reasoningEffort: 'max' });
  await send(); expect(order).toEqual(['think', 'send']); expect(mocks.warn).not.toHaveBeenCalled();
});
it.each(['aria-checked', 'aria-selected', 'parent-class'])('reads an already selected %s state without toggling', async state => {
  const html = state === 'parent-class' ? '<div class="ds-button--active"><button id="think">DeepThink</button></div>' : `<button id="think" ${state}="true">DeepThink</button>`;
  const order = setup(html, { model: 'deepseek-flash', reasoningEffort: 'high' });
  await send(); expect(order).toEqual(['send']); expect(mocks.warn).not.toHaveBeenCalled();
});
it('passes worker claims through the same selection path', async () => {
  const order = setup(controls(false), {}, true);
  dom.window.history.replaceState({}, '', '/?clf=worker-1');
  setDeepSeekWorkerBridge({ claim: vi.fn(async () => ({ ok: true as const, text: 'worker task', model: 'deepseek-flash', reasoningEffort: 'high' })),
    ack: vi.fn(async () => ({ ok: true })) });
  await send(); expect(order).toEqual(['think', 'send']);
});
it('records a new worker warning in its own chat after the bridge binds it', async () => {
  const order = setup(controls(false).replace('id="think"', 'id="think" data-stuck="true"'), {}, true);
  dom.window.history.replaceState({}, '', '/?clf=worker-1');
  setDeepSeekWorkerBridge({ claim: vi.fn(async () => ({ ok: true as const, text: 'worker task', model: 'deepseek-flash', reasoningEffort: 'high' })),
    ack: vi.fn(async () => ({ ok: true })) });
  await send(); expect(order).toEqual(['think', 'send']); expect(mocks.note).not.toHaveBeenCalled();
  dom.window.history.pushState({}, '', `/a/chat/s/${conversation}`);
  await vi.advanceTimersByTimeAsync(7000);
  expect(mocks.note).toHaveBeenCalledExactlyOnceWith('session-worker', expect.stringContaining('DeepThink'));
});
it('passes sleeping worker wake claims through the same selection path', async () => {
  const order = setup(controls(false), {});
  mocks.pending.mockReset().mockResolvedValue([]);
  const claimPendingRevival = vi.fn().mockResolvedValueOnce({ ok: true, id: 'wake-1', text: 'wake task', model: 'deepseek-flash', reasoningEffort: 'high' })
    .mockResolvedValue({ ok: false, error: 'no_pending_revival' });
  setDeepSeekWorkerBridge({ claim: vi.fn(), claimPendingRevival, ack: vi.fn(async () => ({ ok: true })) });
  await send(); expect(order).toEqual(['think', 'send']);
});
