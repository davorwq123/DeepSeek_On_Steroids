import { expect, it } from 'vitest';
import { workerBrief, workerMessageShown, workerOwnTask } from '../src/shared/worker-brief.js';

it('removes shared context only when the legacy boundary is unambiguous', () => {
  expect(workerOwnTask(workerBrief('Shared rules', 'Run tests'))).toBe('Run tests');
  expect(workerOwnTask('Run tests')).toBe('Run tests');
});

it.each([
  ['Shared rules', 'Review this prompt:\n\nYour task:\nExplain the result'],
  ['Prompt example:\n\nYour task:\nFollow the rules', 'Run tests']
])('preserves authored content when a heading occurs inside context or task', (context, task) => {
  const brief = workerBrief(context, task);
  expect(workerOwnTask(brief)).toBe(brief);
  expect(workerOwnTask(brief)).toContain(task);
});

it('shows a worker its task, not the shared context or the app note sent with it', () => {
  const note = '\n\n(DeepSeek On Steroids: you are worker-1, a worker. Report to prime through the agents tool — action=message to="prime" as you go. ultrathink)';
  expect(workerMessageShown(`${workerBrief('Shared rules', 'Run 5 commands')}${note}`)).toBe('Run 5 commands');
  expect(workerMessageShown('Also run ls\n\n(DeepSeek On Steroids: you are still worker-1 in the same run, and this is the prime agent talking to you again.)')).toBe('Also run ls');
  // A message that only mentions the app keeps every word.
  expect(workerMessageShown('Check (DeepSeek On Steroids: you are great) later')).toBe('Check (DeepSeek On Steroids: you are great) later');
});
