import { beforeEach, describe, expect, it, vi } from 'vitest';

const unread = vi.fn<(id: string) => string[]>();
const session = vi.fn();
const enqueue = vi.fn();
const goalArmed = vi.fn(() => false);

vi.mock('../src/main/agents.js', () => ({
  onWorkerFinished: vi.fn(() => () => undefined),
  unreadPrimeReportIds: (id: string) => unread(id),
  workerPrimeOwner: vi.fn(() => ({ owned: true, primeConversationId: 'prime-chat', runId: 'r1' }))
}));
vi.mock('../src/main/goal.js', () => ({ goalArmedFor: () => goalArmed() }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../src/main/session/input.js', () => ({ enqueueInput: (...args: unknown[]) => enqueue(...args) }));
vi.mock('../src/main/session/blocked-chats.js', () => ({ isChatBlocked: () => false }));
vi.mock('../src/main/session/store.js', () => ({
  conversationWasSuperseded: async () => false,
  findSessionByConversation: async () => session()
}));

const { wakeIdlePrime, installDeepSeekWorkerReports } = await import('../src/main/deepseek/worker-reports.js');
const { deepSeekAppMessage } = await import('../src/shared/deepseek-display.js');

describe('worker reports for an idle DeepSeek prime', () => {
  beforeEach(() => {
    installDeepSeekWorkerReports()();
    unread.mockReset(); session.mockReset(); enqueue.mockReset(); goalArmed.mockReturnValue(false);
    enqueue.mockResolvedValue({});
  });

  it('tells an idle prime once per new set of reports, as an app note', async () => {
    unread.mockReturnValue(['m1']);
    session.mockReturnValue({ id: 's1', activeTurnId: null });
    expect(await wakeIdlePrime('prime-chat')).toBe('woken');
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [input, , options] = enqueue.mock.calls[0]!;
    expect(input).toMatchObject({ sessionId: 's1', authoredSource: 'none', mode: 'auto' });
    expect(input.text).toContain('action "status"');
    expect(options).toEqual({ transport: 'browser' });
    expect(deepSeekAppMessage(input.text)).toEqual({ kind: 'worker-reports' });
    expect(await wakeIdlePrime('prime-chat')).toBe('skipped');
    unread.mockReturnValue(['m1', 'm2']);
    expect(await wakeIdlePrime('prime-chat')).toBe('woken');
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('leaves a running turn, a Goal chat and a read inbox alone', async () => {
    unread.mockReturnValue(['m1']);
    session.mockReturnValue({ id: 's1', activeTurnId: 'turn-1' });
    expect(await wakeIdlePrime('prime-chat')).toBe('busy');
    goalArmed.mockReturnValue(true);
    expect(await wakeIdlePrime('prime-chat')).toBe('skipped');
    goalArmed.mockReturnValue(false);
    unread.mockReturnValue([]);
    expect(await wakeIdlePrime('prime-chat')).toBe('none');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
