import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

/**
 * A DeepSeek prime whose workers are still running does not take its next Goal step from an
 * answer written before their reports: the decision waits, then is taken once they stop.
 */

const workers = vi.hoisted(() => ({ waiting: new Set<string>(), finished: new Set<(id: string) => void>() }));
vi.mock('../src/main/agents.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/main/agents.js')>()),
  waitingForSubAgents: (id: string) => workers.waiting.has(id),
  onWorkerFinished: (listener: (id: string) => void) => {
    workers.finished.add(listener);
    return () => workers.finished.delete(listener);
  }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore, resetDurableForTests } = await import('../src/main/durable.js');
const { createSession, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { listInputs, resetInputForTests } = await import('../src/main/session/input.js');
const goal = await import('../src/main/goal.js');
const { advanceDeepSeekGoal, resetDeepSeekGoalForTests } = await import('../src/main/deepseek/goal.js');

let directory: string;
beforeAll(async () => {
  directory = await makeTempDir('cos-deepseek-goal-workers-');
  initConfigPath(directory);
  initSecretsPath(directory);
  initSessionStore(directory);
  initDurableStore(directory);
});
beforeEach(async () => {
  goal.resetGoalStateForTests();
  resetDeepSeekGoalForTests();
  resetInputForTests();
  workers.waiting.clear();
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, mode: 'goal', backend: 'chatgpt' } });
});
afterEach(() => {
  resetDeepSeekGoalForTests();
  resetInputForTests();
  goal.resetGoalStateForTests();
});
afterAll(async () => {
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

const steps = async (conversationId: string) => (await listInputs()).filter(row => row.goalStep?.conversationId === conversationId);

it('holds a "complete" written while workers run, then asks for their reports once they stop', async () => {
  const conversationId = 'ds-goal-workers';
  const session = await createSession({ title: 'DeepSeek goal workers', conversationId });
  await goal.setGoalSwitchNow(conversationId, 'goal', true);
  await goal.setGoalObjectiveNow(conversationId, 'Ship the parser.');
  workers.waiting.add(conversationId);

  const held = await advanceDeepSeekGoal({ conversationId, sessionId: session.id, messageId: 'ds:a1', text: 'Done.\n[[COS_GOAL:COMPLETE]]' });
  expect(held).toBe('waiting');
  expect(await steps(conversationId)).toEqual([]);
  expect(goal.goalArmedFor(conversationId)).toBe(true);

  workers.waiting.delete(conversationId);
  for (const listener of workers.finished) listener('worker-chat');
  await vi.waitFor(async () => expect(await steps(conversationId)).toHaveLength(1));
  const [step] = await steps(conversationId);
  expect(step!.text).toContain('Ship the parser.');
  expect(step!.text).toContain('Your workers stopped after your last answer');
  expect(goal.goalArmedFor(conversationId)).toBe(true);
});

it('decides at once when no worker is running', async () => {
  const conversationId = 'ds-goal-no-workers';
  const session = await createSession({ title: 'DeepSeek goal', conversationId });
  await goal.setGoalSwitchNow(conversationId, 'goal', true);
  expect(await advanceDeepSeekGoal({ conversationId, sessionId: session.id, messageId: 'ds:b1', text: 'More to do.\n[[COS_GOAL:CONTINUE]]' })).toBe('continued');
  expect(await steps(conversationId)).toHaveLength(1);
});
