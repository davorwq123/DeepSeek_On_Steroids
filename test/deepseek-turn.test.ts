import { describe, expect, it } from 'vitest';
import { runDeepSeekTurn, type DeepSeekCallOutcome, type DeepSeekCompletedCall } from '../src/main/deepseek/turn.js';
import type { DeepSeekToolDescriptor, DeepSeekToolProposal } from '../src/main/deepseek/tool-protocol.js';

const tools: DeepSeekToolDescriptor[] = [
  { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } },
  { name: 'exec_command', description: 'Run a command', inputSchema: { type: 'object' } }
];
const envelope = (calls: unknown[]) => JSON.stringify({ type: 'tool_calls', calls });

describe('DeepSeek tool turn', () => {
  it('leaves an ordinary answer alone', async () => {
    const ran: string[] = [];
    const outcome = await runDeepSeekTurn('Here is the answer.', {
      tools,
      execute: async call => { ran.push(call.name); return { text: '', isError: false }; }
    });
    expect(outcome).toEqual({ status: 'answer', text: 'Here is the answer.' });
    expect(ran).toEqual([]);
  });

  it('runs accepted calls in order and reports their exact results', async () => {
    const ran: string[] = [];
    const outcome = await runDeepSeekTurn(envelope([
      { id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
      { id: 'c2', name: 'exec_command', arguments: { cmd: 'npm test' } }
    ]), {
      tools,
      execute: async (call: DeepSeekToolProposal) => {
        ran.push(call.id);
        return { text: `result of ${call.name}`, isError: call.name === 'exec_command' };
      }
    });
    expect(outcome.status).toBe('tools');
    expect(ran).toEqual(['c1', 'c2']);
    if (outcome.status !== 'tools') throw new Error('expected tools');
    expect(outcome.calls).toEqual<DeepSeekCallOutcome[]>([
      { id: 'c1', name: 'read', isError: false, chars: 'result of read'.length },
      { id: 'c2', name: 'exec_command', isError: true, chars: 'result of exec_command'.length }
    ]);
    expect(outcome.continuation).toContain('"type":"tool_results"');
    expect(outcome.continuation).toContain('"id":"c1"');
    expect(outcome.continuation).toContain('result of read');
    expect(outcome.continuation).toContain('"ok":false');
    expect(outcome.continuation).toContain('Continue the task');
  });

  it('runs a real command whose envelope lost its opening brace to the native control token', async () => {
    const ran: DeepSeekToolProposal[] = [];
    const outcome = await runDeepSeekTurn('<｜type":"tool_calls","calls":[{"id":"pwd-call","name":"exec_command","arguments":{"cmd":"pwd","workdir":"/moneymaker"}}]}', {
      tools,
      execute: async call => { ran.push(call); return { text: '/moneymaker', isError: false }; }
    });
    expect(ran).toEqual([{ id: 'pwd-call', name: 'exec_command', arguments: { cmd: 'pwd', workdir: '/moneymaker' } }]);
    if (outcome.status !== 'tools') throw new Error('expected tools');
    expect(outcome.calls).toEqual([{ id: 'pwd-call', name: 'exec_command', isError: false, chars: '/moneymaker'.length }]);
    expect(outcome.continuation).toContain('/moneymaker');
  });

  it('executes nothing when any call is invalid', async () => {
    const ran: string[] = [];
    const outcome = await runDeepSeekTurn(envelope([
      { id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
      { id: 'c2', name: 'delete_everything', arguments: {} }
    ]), {
      tools,
      execute: async call => { ran.push(call.name); return { text: '', isError: false }; }
    });
    expect(outcome.status).toBe('invalid');
    expect(ran).toEqual([]);
    if (outcome.status !== 'invalid') throw new Error('expected invalid');
    expect(outcome.reason).toContain('Unknown tool');
    expect(outcome.continuation).toContain('No tool ran');
    expect(outcome.continuation).toContain('read, exec_command');
  });

  it('turns a thrown tool failure into a result instead of losing the batch', async () => {
    const outcome = await runDeepSeekTurn(envelope([{ id: 'c1', name: 'read', arguments: {} }]), {
      tools,
      execute: async () => { throw new Error('disk unavailable'); }
    });
    if (outcome.status !== 'tools') throw new Error('expected tools');
    expect(outcome.calls[0]!.isError).toBe(true);
    expect(outcome.continuation).toContain('disk unavailable');
  });

  it('bounds a large result and says so in the result itself', async () => {
    const huge = 'x'.repeat(200_000);
    const outcome = await runDeepSeekTurn(envelope([{ id: 'c1', name: 'read', arguments: {} }]), {
      tools,
      execute: async () => ({ text: huge, isError: false }),
      maxContinuationChars: 10_000
    });
    if (outcome.status !== 'tools') throw new Error('expected tools');
    expect(outcome.continuation.length).toBeLessThanOrEqual(10_000);
    expect(outcome.continuation).toContain('truncated by the app');
    // Still one complete JSON envelope: a truncated result must not truncate its framing.
    const [line] = outcome.continuation.split('\n');
    expect(() => JSON.parse(line!)).not.toThrow();
  });

  it('bounds retained retry results while preserving their original sizes and exact continuation', async () => {
    const completedCalls = new Map<string, DeepSeekCompletedCall>();
    const reply = envelope([
      { id: 'one', name: 'read', arguments: {} }, { id: 'two', name: 'read', arguments: {} }
    ]);
    const first = await runDeepSeekTurn(reply, {
      tools, completedCalls, maxContinuationChars: 10_000,
      execute: async () => ({ text: '😀'.repeat(200_000), isError: false })
    });
    expect([...completedCalls.values()].reduce((total, result) => total + result.text.length, 0)).toBeLessThanOrEqual(10_000);
    expect([...completedCalls.values()].map(result => result.chars)).toEqual([400_000, 400_000]);
    const retried = await runDeepSeekTurn(reply, {
      tools, completedCalls, maxContinuationChars: 10_000,
      execute: async () => { throw new Error('an accepted call must not run again'); }
    });
    expect(retried).toEqual(first);
    if (retried.status !== 'tools') throw new Error('expected tools');
    expect(retried.continuation).toContain('of 400000 characters');
  });

  it('never splits a surrogate pair when bounding', async () => {
    const outcome = await runDeepSeekTurn(envelope([{ id: 'c1', name: 'read', arguments: {} }]), {
      tools,
      execute: async () => ({ text: '😀'.repeat(50_000), isError: false }),
      maxContinuationChars: 9_003
    });
    if (outcome.status !== 'tools') throw new Error('expected tools');
    const body = JSON.parse(outcome.continuation.split('\n')[0]!);
    expect(body.results[0].content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(body.results[0].content).toContain('truncated by the app');
  });
});
