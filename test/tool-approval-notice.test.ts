import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
});
afterEach(() => dom.window.close());

it('shows the reminder once after acknowledgement, and Setup carries no ChatGPT plugin walkthrough', async () => {
  let opening!: () => void;
  Object.defineProperty(window, 'api', { configurable: true, value: { onToolApprovalNotice: (listener: () => void) => { opening = listener; return () => {}; } } });
  const { initSetupGuide } = await import('../src/renderer/setup-guide.js');
  initSetupGuide();
  // DeepSeek runs tools inside the app: there is no plugin to create in a chat site, so no guide for it.
  expect(document.querySelector('[data-setup-guide="plugin"]')).toBeNull();
  expect(document.querySelectorAll('#pluginMoves .guide-move')).toHaveLength(0);
  const dialog = document.querySelector('.tool-approval-dialog') as HTMLDialogElement;
  expect(dialog.open).toBe(false); opening(); expect(dialog.open).toBe(true);
  expect(window.localStorage.getItem('cos.tool-approval-notice.v1')).toBeNull();
  (dialog.querySelector('button') as HTMLButtonElement).click();
  expect(dialog.open).toBe(false); opening(); expect(dialog.open).toBe(false);
  const { initToolApprovalNotice } = await import('../src/renderer/tool-approval.js');
  initToolApprovalNotice(listener => { opening = listener; return () => {}; });
  opening(); expect([...document.querySelectorAll('dialog')].some(item => item.open)).toBe(false);
});
it('does not require local storage and never uses a browser or approval action', async () => {
  vi.spyOn(dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  const { initToolApprovalNotice } = await import('../src/renderer/tool-approval.js');
  let opening!: () => void;
  initToolApprovalNotice(listener => { opening = listener; return () => {}; });
  opening(); const dialog = document.querySelector('.tool-approval-dialog') as HTMLDialogElement;
  expect(dialog.open).toBe(true); dialog.close(); opening(); expect(dialog.open).toBe(false);
  expect(dialog.textContent).toContain('does not approve a tool call');
});
