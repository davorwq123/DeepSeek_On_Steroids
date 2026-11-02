import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InputArgs, InputEntry } from '../src/main/session/input.js';
// DeepSeek runs in this app's own browser: a send needs no tunnel or extension, only the exact page.
const ports = vi.hoisted(() => ({ page: vi.fn(), enqueue: vi.fn(), cancel: vi.fn(), note: vi.fn(), rows: [] as InputEntry[] }));
vi.mock('../src/main/deepseek/browser.js', () => ({ ensureDeepSeekPage: ports.page }));
vi.mock('../src/main/browser-startup.js', () => ({ resetBrowserStartupForTests: () => undefined }));
vi.mock('../src/main/session/input.js', () => ({ enqueueInput: ports.enqueue, cancelInput: ports.cancel, noteInputStartupError: ports.note, listInputs: async () => ports.rows }));
import { sendDesktopInput, cancelDesktopInput, retryQueuedInputBrowser, resetInputStartupForTests, startInputSignInRetry, stopInputStartup } from '../src/main/session/start-input.js';
import { cosBrowserSignedIn, setCosBrowserSignedIn } from '../src/main/cos-browser/sign-in.js';
import { SIGN_IN_PREFIX, SIGN_IN_WAITING } from '../src/shared/input.js';
const request: InputArgs = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionId: null, text: 'Please start', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null };
const other = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
beforeEach(() => {
  vi.resetAllMocks(); resetInputStartupForTests();
  setCosBrowserSignedIn(null);
  ports.rows = [];
  ports.page.mockResolvedValue(undefined);
  ports.enqueue.mockImplementation(async (input: InputArgs): Promise<InputEntry> => {
    const row: InputEntry = { ...input, ...(input.delivery === 'tool' ? { transportIntent: 'tool' as const } : {}),
      state: 'queued', owner: null, createdAt: 1, conversationId: input.sessionId ? 'exact-conversation' : null };
    ports.rows.push(row); return row;
  });
  ports.cancel.mockImplementation(async id => { const row = ports.rows.find(entry => entry.id === id); if (!row) return false; row.state = 'cancelled'; return true; });
  ports.note.mockImplementation(async (id, error) => { const row = ports.rows.find(entry => entry.id === id); if (row) row.error = error ?? undefined; return row; });
});
afterEach(() => { stopInputStartup(); setCosBrowserSignedIn(null); });

it('keeps a signed-out desktop send queued and automatically retries the same row after sign-in', async () => {
  setCosBrowserSignedIn(false);
  startInputSignInRetry(); startInputSignInRetry();
  ports.page.mockImplementation(async () => { if (cosBrowserSignedIn() === false) throw new Error(SIGN_IN_WAITING); });
  await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.rows[0]?.error).toBe(SIGN_IN_WAITING));
  expect(ports.rows[0]).toMatchObject({ state: 'queued', owner: null });
  expect(ports.rows[0]!.error!.startsWith(SIGN_IN_PREFIX)).toBe(true);

  setCosBrowserSignedIn(true);
  await vi.waitFor(() => expect(ports.page).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(ports.rows[0]?.error).toBeUndefined());
  expect(ports.page).toHaveBeenLastCalledWith({ inputId: request.id });
  expect(ports.enqueue).toHaveBeenCalledOnce();
  expect(ports.rows).toHaveLength(1);
});

it('retries sign-in holds oldest first, one at a time, and rechecks cancellations and other failures', async () => {
  setCosBrowserSignedIn(false);
  const row: InputEntry = { ...request, state: 'queued', owner: null, createdAt: 1, conversationId: null, error: SIGN_IN_WAITING };
  ports.rows = [
    { ...row, id: other, createdAt: 2 }, row,
    { ...row, id: 'cancel-me', createdAt: 3 },
    { ...row, id: 'browser-error', error: 'Message queued. Browser startup failed: unrelated' },
    { ...row, id: 'claimed', state: 'browser', owner: 'page' },
    { ...row, id: 'failed', state: 'failed' },
    { ...row, id: 'decision', purpose: 'decision' }
  ];
  let release!: () => void;
  ports.page.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  startInputSignInRetry();
  setCosBrowserSignedIn(null);
  await Promise.resolve();
  expect(ports.page).not.toHaveBeenCalled();
  setCosBrowserSignedIn(true);
  await vi.waitFor(() => expect(ports.page).toHaveBeenCalledExactlyOnceWith({ inputId: request.id }));
  await cancelDesktopInput('cancel-me');
  // A second sign-in event cannot overlap the retry already opening a page.
  setCosBrowserSignedIn(false); setCosBrowserSignedIn(true);
  await Promise.resolve();
  expect(ports.page).toHaveBeenCalledOnce();
  release();
  await vi.waitFor(() => expect(ports.rows.find(entry => entry.id === other)?.error).toBeUndefined());
  expect(ports.page.mock.calls).toEqual([[{ inputId: request.id }], [{ inputId: other }]]);
  expect(ports.rows.find(entry => entry.id === 'cancel-me')?.state).toBe('cancelled');
  expect(ports.rows.find(entry => entry.id === 'browser-error')?.error).toContain('unrelated');
});

it('retries when sign-in finishes before startup publishes the waiting reason', async () => {
  setCosBrowserSignedIn(false);
  startInputSignInRetry();
  let refuse!: (error: Error) => void;
  ports.page.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
  await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.page).toHaveBeenCalledOnce());
  setCosBrowserSignedIn(true);
  // Let the sign-in listener scan before the opener reports its signed-out result.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(ports.rows[0]?.error).toBeUndefined();
  refuse(new Error(SIGN_IN_WAITING));
  await vi.waitFor(() => expect(ports.page).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(ports.rows[0]?.error).toBeUndefined());
});

it('does not resume sign-in holds after shutdown', async () => {
  setCosBrowserSignedIn(false);
  ports.rows = [{ ...request, state: 'queued', owner: null, createdAt: 1, conversationId: null, error: SIGN_IN_WAITING }];
  startInputSignInRetry();
  stopInputStartup();
  setCosBrowserSignedIn(true);
  await Promise.resolve();
  expect(ports.page).not.toHaveBeenCalled();
  expect(ports.rows[0]?.error).toBe(SIGN_IN_WAITING);
});

it('accepts a new chat message and opens its own DeepSeek page without waiting for a connector', async () => {
  expect(await sendDesktopInput(request)).toMatchObject({ id: request.id, state: 'queued' });
  await vi.waitFor(() => expect(ports.page).toHaveBeenCalledWith({ inputId: request.id }));
  expect(ports.enqueue.mock.invocationCallOrder[0]).toBeLessThan(ports.page.mock.invocationCallOrder[0]!);
  await vi.waitFor(() => expect(ports.note).toHaveBeenCalledWith(request.id, null));
  expect(ports.rows[0]).toMatchObject({ state: 'queued', error: undefined });
});
it('opens an existing chat by its exact conversation', async () => {
  await sendDesktopInput({ ...request, sessionId: 'session-existing' });
  await vi.waitFor(() => expect(ports.page).toHaveBeenCalledWith({ conversationId: 'exact-conversation' }));
});
it('leaves explicit tool delivery on the durable queue without opening a page', async () => {
  const row = await sendDesktopInput({ ...request, sessionId: 'session-existing', delivery: 'tool' });
  expect(row).toMatchObject({ state: 'queued', delivery: 'tool', transportIntent: 'tool' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(ports.page).not.toHaveBeenCalled();
});
it('keeps a message whose page failed to open queued, and retries only that page for the same UUID', async () => {
  ports.page.mockRejectedValueOnce(new Error('startup refused'));
  await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.rows[0]?.error).toBe('Message queued. Browser startup failed: startup refused'));
  await Promise.all([retryQueuedInputBrowser(request.id), retryQueuedInputBrowser(request.id)]);
  expect(ports.page).toHaveBeenCalledTimes(2);
  expect(ports.enqueue).toHaveBeenCalledTimes(1);
  expect(ports.rows).toHaveLength(1);
  expect(ports.rows[0]).toMatchObject({ id: request.id, state: 'queued', error: undefined });
  expect(await retryQueuedInputBrowser(request.id)).toBeNull();
  ports.rows[0]!.state = 'browser'; ports.rows[0]!.error = 'Message queued. Browser startup failed: old';
  expect(await retryQueuedInputBrowser(request.id)).toBeNull();
});
it('still retries a message an older version held back for Setup', async () => {
  ports.rows.push({ ...request, state: 'queued', owner: null, createdAt: 1, conversationId: null, error: 'Message queued. Finish Setup to send: Add a folder before connecting.' });
  expect(await retryQueuedInputBrowser(request.id)).toMatchObject({ state: 'queued', error: undefined });
  expect(ports.page).toHaveBeenCalledWith({ inputId: request.id });
});
it('clears a local chat setup failure on retry without opening a page', async () => {
  ports.rows.push({ ...request, state: 'queued', owner: null, createdAt: 1, conversationId: null, error: 'Local chat setup failed: disk' });
  ports.note.mockImplementationOnce(async () => ({ ...ports.rows[0]!, error: 'Local chat setup failed: still broken' }));
  expect(await retryQueuedInputBrowser(request.id)).toMatchObject({ error: 'Local chat setup failed: still broken' });
  expect(ports.page).not.toHaveBeenCalled();
});
it('never retries a Goal decision row', async () => {
  ports.rows.push({ ...request, state: 'queued', owner: null, createdAt: 1, conversationId: null, purpose: 'decision', error: 'Message queued. Browser startup failed: x' } as InputEntry);
  expect(await retryQueuedInputBrowser(request.id)).toBeNull();
  expect(ports.page).not.toHaveBeenCalled();
});
it('sends a second message while the first page is still opening', async () => {
  let release!: () => void;
  ports.page.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const first = await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.page).toHaveBeenCalledTimes(1));
  const second = await sendDesktopInput({ ...request, id: other });
  expect([first.state, second.state]).toEqual(['queued', 'queued']);
  await vi.waitFor(() => expect(ports.page).toHaveBeenCalledTimes(2));
  release();
  await vi.waitFor(() => expect(ports.note).toHaveBeenCalledTimes(2));
});
it('cancels an enqueue that commits after the user stopped startup', async () => {
  let commit!: () => void;
  ports.enqueue.mockImplementation(() => new Promise(resolve => { commit = () => resolve({ ...request, state: 'queued' }); }));
  const pending = sendDesktopInput(request);
  const rejected = expect(pending).rejects.toThrow('Input cancelled');
  await vi.waitFor(() => expect(ports.enqueue).toHaveBeenCalled());
  expect(await cancelDesktopInput(request.id)).toBe(true);
  commit(); await rejected;
  expect(ports.cancel).toHaveBeenCalledWith(request.id);
  expect(ports.page).not.toHaveBeenCalled();
});
it('refuses new sends and retries once the app is shutting down', async () => {
  ports.page.mockRejectedValueOnce(new Error('startup refused'));
  await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.rows[0]?.error).toContain('Browser startup failed'));
  stopInputStartup();
  expect(await retryQueuedInputBrowser(request.id)).toBeNull();
  await expect(sendDesktopInput({ ...request, id: other })).rejects.toThrow('shutting down');
  expect(ports.page).toHaveBeenCalledTimes(1);
});
