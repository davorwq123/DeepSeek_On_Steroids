import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from '../src/shared/types.js';

const saved = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../src/main/durable.js', () => ({ readDurable: async () => saved.value, writeDurableSoon: vi.fn() }));
let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); saved.value = null; });

it.each([null, { observedAt: 10, models: [{ id: 'deepseek-flash', label: 'Old Flash', efforts: ['low'] }] }])(
  'offers the one DeepSeek web model with binary thinking despite saved catalog %j', async value => {
    saved.value = value;
    const { getChatModels, restoreChatModels, requestChatModels, observeChatModels, pendingChatModelRequest } = await import('../src/main/chat-models.js');
    await restoreChatModels();
    const expected = [
      { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', efforts: ['none', 'high'] }
    ];
    expect(getChatModels()).toMatchObject({ state: 'ready', models: expected });
    requestChatModels();
    observeChatModels({ nonce: pendingChatModelRequest()!.nonce, models: [{ id: 'deepseek-flash', label: 'Old Flash', efforts: ['low'] }] });
    expect(getChatModels().models).toMatchObject(expected);
    expect(getChatModels().models).toHaveLength(1);
  }
);

it.each(['none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh', 'ultra', 'pro'])('maps a saved V4-Pro choice with effort %s to Flash and the web toggle', async savedEffort => {
  const { getChatModels } = await import('../src/main/chat-models.js');
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: getChatModels() }) } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, composerSendModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  applyChatModels({ ui: { defaultChatModel: 'deepseek-v4-pro', defaultChatReasoning: savedEffort }, multiAgent: {}, goal: {} } as Config);
  await Promise.resolve();
  applyComposerSessionModel(null, null);
  expect(composerSendModel()).toEqual({ model: 'deepseek-flash', reasoningEffort: savedEffort === 'none' ? 'none' : 'high' });
});

it('lists the model and changes thinking using the visible composer picker before sending', async () => {
  const { getChatModels } = await import('../src/main/chat-models.js');
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: getChatModels() }) } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, composerSendModel, ensureComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  applyComposerSessionModel(null, null);
  const doc = dom.window.document;
  expect([...doc.querySelectorAll('#composerModelOptions [data-model]')].map(node => node.textContent)).toEqual([
    'DeepSeek-V4.1-Flash'
  ]);
  for (const id of ['composerModel', 'defaultChatModel', 'workerModel', 'helperModel']) {
    const select = doc.getElementById(id) as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(['deepseek-flash']);
    expect(select.value).toBe('deepseek-flash');
  }
  for (const id of ['defaultChatReasoning', 'workerReasoning']) {
    expect([...(doc.getElementById(id) as HTMLSelectElement).options].map(option => option.value)).toEqual(['none', 'high']);
  }
  expect(composerSendModel()).toEqual({ model: 'deepseek-flash', reasoningEffort: 'none' });
  (doc.getElementById('modelMenu') as HTMLDetailsElement).open = true;
  doc.getElementById('composerModelToggle')!.click();
  expect(doc.getElementById('composerModelChoices')!.hidden).toBe(false);
  doc.querySelector<HTMLButtonElement>('[data-model="deepseek-flash"]')!.click();
  const slider = doc.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  expect(slider).not.toBeNull(); expect(slider.disabled).toBe(false); expect(slider.max).toBe('1');
  expect(doc.getElementById('composerPowerChoices')!.textContent).toBe('Thinking offDeepThink');
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(await ensureComposerModel()).toEqual({ model: 'deepseek-flash', reasoningEffort: 'high' });
  expect(doc.getElementById('composerModelLabel')!.textContent).toBe('DeepSeek-V4.1-Flash · DeepThink');
  slider.value = '0'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(composerSendModel()).toEqual({ model: 'deepseek-flash', reasoningEffort: 'none' });
});

it('keeps DeepThink available when another page has no toggle', async () => {
  const { getChatModels, noteDeepThinkControl } = await import('../src/main/chat-models.js');
  expect(getChatModels().models[0]!.efforts).toEqual(['none', 'high']);
  noteDeepThinkControl(false);
  expect(getChatModels().models).toMatchObject([{ id: 'deepseek-flash', efforts: ['none', 'high'] }]);
  noteDeepThinkControl(true);
  expect(getChatModels().models[0]!.efforts).toEqual(['none', 'high']);
});

it('sends fixed Flash with explicit thinking when an existing chat has no model observation', async () => {
  const { getChatModels } = await import('../src/main/chat-models.js');
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: getChatModels() }) } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, composerSendModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ ui: {}, multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  applyComposerSessionModel('existing-without-observation', null);
  expect(composerSendModel()).toEqual({ model: 'deepseek-flash', reasoningEffort: 'none' });
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(composerSendModel()).toEqual({ model: 'deepseek-flash', reasoningEffort: 'high' });
  applyComposerSessionModel('another-chat', { model: 'deepseek-v4-pro', reasoningEffort: 'max', observedAt: 10 });
  expect(composerSendModel()).toEqual({ model: 'deepseek-flash', reasoningEffort: 'high' });
});

it('retains the chosen DeepThink level through a background page reporting no toggle', async () => {
  const { getChatModels, noteDeepThinkControl } = await import('../src/main/chat-models.js');
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let receive = (_value: ReturnType<typeof getChatModels>) => {};
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: getChatModels() }),
    onChatModelsChanged: (listener: typeof receive) => { receive = listener; }
  } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, composerSendModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ ui: {}, multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  applyComposerSessionModel(null, null);
  const doc = dom.window.document;
  const slider = doc.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  noteDeepThinkControl(false);
  receive(getChatModels());
  expect(composerSendModel()).toEqual({ model: 'deepseek-flash', reasoningEffort: 'high' });
  expect(doc.querySelector('#composerModelOptions [data-model=""]')).toBeNull();
  const current = doc.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  expect(current.disabled).toBe(false);
  expect(current.value).toBe('1');
  current.value = '0'; current.dispatchEvent(new dom.window.Event('input'));
  expect(composerSendModel()).toEqual({ model: 'deepseek-flash', reasoningEffort: 'none' });
});

it('sends the fixed model immediately while optional catalog refresh is pending', async () => {
  const { getChatModels, requestChatModels } = await import('../src/main/chat-models.js');
  requestChatModels(false);
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const request = vi.fn();
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: getChatModels() }), requestChatModels: request } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, ensureComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ ui: {}, multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  applyComposerSessionModel(null, null);
  let resolved = false;
  const sending = ensureComposerModel().then(value => { resolved = true; return value; });
  await Promise.resolve();
  expect(resolved).toBe(true);
  expect(await sending).toEqual({ model: 'deepseek-flash', reasoningEffort: 'none' });
  expect(request).not.toHaveBeenCalled();
});
