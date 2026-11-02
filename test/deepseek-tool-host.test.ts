import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

const recorded = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
const ran = vi.hoisted(() => ({ calls: [] as string[] }));
const connectorUse = vi.hoisted(() => vi.fn());

vi.mock('../src/main/session/recorder.js', async (original) => ({
  ...(await original<typeof import('../src/main/session/recorder.js')>()),
  freshCallOrigin: () => null,
  recordToolCall: async (input: Record<string, unknown>) => { recorded.calls.push(input); return null; }
}));
vi.mock('../src/main/session/store.js', async (original) => ({
  ...(await original<typeof import('../src/main/session/store.js')>()),
  conversationAttachment: async () => 'current'
}));
vi.mock('../src/main/session/input.js', async (original) => ({
  ...(await original<typeof import('../src/main/session/input.js')>()),
  offerToolInput: async () => ({ messages: [], reminder: '' }),
  acknowledgeToolInput: async () => undefined
}));
vi.mock('../src/main/connector-proof.js', async (original) => ({
  ...(await original<typeof import('../src/main/connector-proof.js')>()),
  noteConnectorUse: connectorUse
}));

import { describeDeepSeekTools, createDeepSeekToolHost, deepSeekToolResultText } from '../src/main/deepseek/tool-host.js';
import { buildDeepSeekToolInstructions } from '../src/main/deepseek/tool-protocol.js';
import { defaultConfig } from '../src/main/config.js';
import { ok, type SurfaceRegistrar } from '../src/main/mcp/kernel.js';

const ctx = () => ({ roots: [], caps: { ...defaultConfig().capabilities }, readOnly: false });
function register(registrar: SurfaceRegistrar): void {
  for (const name of ['read', 'agents', 'session_finish']) {
    registrar.register(name, {
      description: `${name} description`,
      inputSchema: z.object({ path: z.string().optional() }),
      ...(name === 'read' ? { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } } : {})
    }, async () => { ran.calls.push(name); return ok(`${name} ran`); });
  }
}

beforeEach(() => { recorded.calls.length = 0; ran.calls.length = 0; connectorUse.mockClear(); });

it('advertises the coding loop and agents, not broker-only or code-mode tools', () => {
  const tools = describeDeepSeekTools({ ctx: ctx(), register });
  // `agents` is how a DeepSeek prime starts workers and how a worker reports and finishes.
  expect(tools.map(tool => tool.name)).toEqual(['read', 'agents']);
  expect(tools[0]).toMatchObject({ name: 'read', description: 'read description' });
  expect(tools[1]).toMatchObject({ name: 'agents', description: 'agents description' });
});

it('offers agents from the real Core surface, with a bounded opening protocol', () => {
  const tools = describeDeepSeekTools({ ctx: { ...ctx(), agentTools: true, exposedAgentTools: true } });
  expect(tools.map(tool => tool.name)).toContain('agents');
  const protocol = buildDeepSeekToolInstructions(tools);
  expect(protocol).toContain('"type":"tool_calls"');
  // The catalog rides every opening message beside the Core instructions; an unbounded one
  // would spend the app's 96,000-character ceiling before the task did.
  expect(protocol.length).toBeLessThan(30_000);
});

it('delivers structured state from the actual Core agents status handler to DeepSeek', async () => {
  const host = createDeepSeekToolHost({ conversationId: 'deepseek-no-family', sessionId: 'session-no-family',
    ctx: { ...ctx(), agentTools: true, exposedAgentTools: true } });
  const result = await host.run('agents', { action: 'status' });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ action: 'status', run_id: null, self: null, agents: [] });
  const delivered = deepSeekToolResultText(result);
  expect(JSON.parse(delivered.split('\nStructured result:\n')[1]!)).toEqual(result.structuredContent);
});

it('runs a tool as the app caller and records it once with the exact conversation', async () => {
  const host = createDeepSeekToolHost({ conversationId: 'chat-1', sessionId: 'session-1', ctx: ctx(), register });
  const result = await host.run('read', { path: 'a.ts' });
  expect(result.isError).not.toBe(true);
  expect(result.content).toEqual([{ type: 'text', text: 'read ran' }]);
  expect(ran.calls).toEqual(['read']);
  expect(recorded.calls).toHaveLength(1);
  expect(recorded.calls[0]).toMatchObject({
    tool: 'read',
    conversationId: 'chat-1',
    sessionId: 'session-1',
    requestId: null
  });
  // A root call, not a code-mode child: the chat's context meter must count it.
  expect(recorded.calls[0]!.nested).not.toBe(true);
  // The app calling its own surface is not connector evidence.
  expect(connectorUse).not.toHaveBeenCalled();
});

it('refuses a registered but unadvertised tool without running its handler', async () => {
  const host = createDeepSeekToolHost({ conversationId: 'chat-1', sessionId: 'session-1', ctx: ctx(), register });
  const result = await host.run('session_finish', {});
  expect(result.isError).toBe(true);
  expect(deepSeekToolResultText(result)).toContain('UNKNOWN_TOOL');
  expect(ran.calls).toEqual([]);
  expect(recorded.calls).toEqual([]);
});

it('describes an image it cannot attach as recorded, not as pixels', () => {
  const result = { content: [{ type: 'image' as const, mimeType: 'image/png', data: 'AAAA' }, { type: 'text' as const, text: 'done' }] };
  const text = deepSeekToolResultText(result);
  expect(text).toContain('image/png');
  expect(text).toContain('recorded in the app');
  expect(text).toContain('done');
  expect(text).not.toContain('AAAA');
});

it('carries complete structured worker reports and returned identities to the text protocol', async () => {
  const structuredContent = { action: 'status', run_id: 'run-123', self: 'prime', free_worker_slots: 1,
    agents: [{ id: 'worker-1', state: 'sleeping', revivable: true, result: 'RESULT\n' + 'verified result '.repeat(40) }] };
  const text = deepSeekToolResultText({ content: [{ type: 'text', text: 'worker-1 asleep; latest result: verified result…' }], structuredContent });
  expect(text).toContain(JSON.stringify(structuredContent));
  // The adapter feeds this text into the existing bounded continuation, rather than introducing
  // another transport or an independent truncation policy for structured results.
  const { runDeepSeekTurn, DEEPSEEK_CONTINUATION_CHAR_LIMIT } = await import('../src/main/deepseek/turn.js');
  const reply = await runDeepSeekTurn('{"type":"tool_calls","calls":[{"id":"status","name":"agents","arguments":{"action":"status"}}]}', {
    tools: [{ name: 'agents', description: 'Workers', inputSchema: {} }], execute: async () => ({ text, isError: false })
  });
  expect(reply.status).toBe('tools');
  if (reply.status === 'tools') {
    const envelope = JSON.parse(reply.continuation.split('\n\n')[0]!);
    expect(JSON.parse(envelope.results[0].content.split('\nStructured result:\n')[1])).toEqual(structuredContent);
    expect(reply.continuation.length).toBeLessThanOrEqual(DEEPSEEK_CONTINUATION_CHAR_LIMIT);
  }
  const large = await runDeepSeekTurn('{"type":"tool_calls","calls":[{"id":"status","name":"agents","arguments":{"action":"status"}}]}', {
    tools: [{ name: 'agents', description: 'Workers', inputSchema: {} }],
    execute: async () => ({ text: deepSeekToolResultText({ content: [], structuredContent: { result: 'x'.repeat(100_000) } }), isError: false })
  });
  expect(large.status).toBe('tools');
  if (large.status === 'tools') {
    expect(large.continuation.length).toBeLessThanOrEqual(DEEPSEEK_CONTINUATION_CHAR_LIMIT);
    expect(large.continuation).toContain('truncated by the app');
  }
});
