import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore, resetDurableForTests } = await import('../src/main/durable.js');
const { createSession, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { cancelGoalStepInputs, listInputs, resetInputForTests } = await import('../src/main/session/input.js');
const goal = await import('../src/main/goal.js');
const { advanceDeepSeekGoal, deepSeekGoalStepId, pauseDeepSeekGoalForThrottle, resetDeepSeekGoalForTests } = await import('../src/main/deepseek/goal.js');

let directory: string;
beforeAll(async () => {
  directory = await makeTempDir('cos-deepseek-goal-');
  initConfigPath(directory);
  initSecretsPath(directory);
  initSessionStore(directory);
  initDurableStore(directory);
});
beforeEach(async () => {
  goal.resetGoalStateForTests();
  resetDeepSeekGoalForTests();
  resetInputForTests();
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

async function armed(conversationId: string, mode: 'goal' | 'loop' = 'goal') {
  const session = await createSession({ title: 'DeepSeek goal test', conversationId });
  await goal.setGoalSwitchNow(conversationId, mode, true);
  await goal.setGoalObjectiveNow(conversationId, 'Write the acceptance file.');
  return session;
}

describe('DeepSeek Goal/Loop transport', () => {
  it('queues exactly one marked continuation for a settled continue answer', async () => {
    const conversationId = 'ds-goal-continue';
    const session = await armed(conversationId);
    const messageId = 'ds:conversation:assistant:continue';
    const first = await advanceDeepSeekGoal({
      conversationId, sessionId: session.id, messageId, text: 'Still working.\n[[COS_GOAL:CONTINUE]]'
    });
    expect(first).toBe('continued');
    const rows = (await listInputs()).filter(row => row.goalStep?.conversationId === conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: deepSeekGoalStepId(conversationId, messageId),
      sessionId: session.id,
      mode: 'auto',
      state: 'queued',
      transportIntent: 'browser',
      authoredSource: 'none',
      goalStep: { conversationId, messageId }
    });
    expect(rows[0]!.text).toContain('Saved goal for this chat');
    expect(rows[0]!.text).toContain('Write the acceptance file.');
    expect(rows[0]!.text).toContain('[[COS_GOAL:COMPLETE]]');
    expect(rows[0]!.text).toContain('[[COS_GOAL:CONTINUE]]');

    expect(await advanceDeepSeekGoal({
      conversationId, sessionId: session.id, messageId, text: 'Still working.\n[[COS_GOAL:CONTINUE]]'
    })).toBe('ignored');
    expect((await listInputs()).filter(row => row.goalStep?.conversationId === conversationId)).toHaveLength(1);
  });

  it('records the objective as met and switches Goal off on the exact completion marker', async () => {
    const conversationId = 'ds-goal-complete';
    const session = await armed(conversationId);
    expect(await advanceDeepSeekGoal({
      conversationId, sessionId: session.id, turnId: 'turn-complete', messageId: 'ds:assistant:complete',
      text: 'Created the acceptance file.\n[[COS_GOAL:COMPLETE]]'
    })).toBe('met');
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ enabled: false, own: true });
    expect(goal.goalOutcomeFor(conversationId)).toMatchObject({ stage: 'no-reply', turnId: 'turn-complete' });
    expect((await listInputs()).filter(row => row.goalStep?.conversationId === conversationId)).toHaveLength(0);
  });

  it('pauses on a missing marker instead of guessing or looping', async () => {
    const conversationId = 'ds-goal-paused';
    const session = await armed(conversationId);
    expect(await advanceDeepSeekGoal({
      conversationId, sessionId: session.id, messageId: 'ds:assistant:plain', text: 'I think that is enough.'
    })).toBe('paused');
    expect(goal.goalSwitchFor(conversationId).enabled).toBe(false);
    expect(goal.goalOutcomeFor(conversationId)).toBeNull();
    expect((await listInputs()).filter(row => row.goalStep?.conversationId === conversationId)).toHaveLength(0);
  });

  it('keeps Loop running even when the answer claims completion', async () => {
    const conversationId = 'ds-loop-complete';
    const session = await armed(conversationId, 'loop');
    expect(await advanceDeepSeekGoal({
      conversationId, sessionId: session.id, messageId: 'ds:assistant:loop', text: 'Done for now.\n[[COS_GOAL:COMPLETE]]'
    })).toBe('continued');
    expect(goal.goalSwitchFor(conversationId).enabled).toBe(true);
    expect((await listInputs()).filter(row => row.goalStep?.conversationId === conversationId)).toHaveLength(1);
  });

  it('pauses Loop and withdraws its pending step when DeepSeek throttles', async () => {
    const conversationId = 'ds-loop-throttled';
    const session = await armed(conversationId, 'loop');
    await advanceDeepSeekGoal({
      conversationId, sessionId: session.id, messageId: 'ds:assistant:throttled', text: 'Still working.\n[[COS_GOAL:CONTINUE]]'
    });
    expect((await listInputs()).filter(row => row.goalStep?.conversationId === conversationId)).toHaveLength(1);

    expect(await pauseDeepSeekGoalForThrottle(conversationId)).toBe(true);
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ enabled: false, own: true, mode: 'loop' });
    const [row] = (await listInputs()).filter(entry => entry.goalStep?.conversationId === conversationId);
    expect(row).toMatchObject({ state: 'cancelled', error: 'Loop paused: DeepSeek asked to slow down.' });
    const events = (await readFile(`${directory}/sessions/${session.id}/events.jsonl`, 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    expect(events.some(event => event.kind === 'note' && /Messages too frequent/.test(event.message?.text ?? ''))).toBe(true);

    // The notice can stay on screen for several polls; it must not append another note.
    expect(await pauseDeepSeekGoalForThrottle(conversationId)).toBe(false);
    expect(goal.goalSwitchFor(conversationId).enabled).toBe(false);
  });

  it('withdraws a queued step when the switch is paused', async () => {
    const conversationId = 'ds-goal-cancel';
    const session = await armed(conversationId);
    await advanceDeepSeekGoal({
      conversationId, sessionId: session.id, messageId: 'ds:assistant:cancel', text: 'More to do.\n[[COS_GOAL:CONTINUE]]'
    });
    expect(await cancelGoalStepInputs(conversationId, 'Paused by the test.')).toBe(1);
    const [row] = (await listInputs()).filter(entry => entry.goalStep?.conversationId === conversationId);
    expect(row).toMatchObject({ state: 'cancelled', error: 'Paused by the test.' });
  });
});
