import { describe, expect, it } from 'vitest';
import { buildDeepSeekToolInstructions, parseDeepSeekReply } from '../src/main/deepseek/tool-protocol.js';
import { GOAL_COMPLETE_MARKER, GOAL_CONTINUE_MARKER } from '../src/shared/goal-templates.js';

const allowed = new Set(['read', 'exec_command']);
const call = { id: 'c1', name: 'read', arguments: { path: 'hello.ts' } };
const envelope = (calls: unknown[]) => JSON.stringify({ type: 'tool_calls', calls });

describe('DeepSeek Web text tool protocol', () => {
  it('reads one trailing envelope as a proposal, even after a short preamble', () => {
    expect(parseDeepSeekReply(envelope([call]), allowed)).toEqual({ kind: 'tool_proposals', calls: [call] });
    const introduced = `I'll create the file with the exact required content.\n\n${envelope([call])}`;
    expect(parseDeepSeekReply(introduced, allowed)).toEqual({ kind: 'tool_proposals', calls: [call] });
  });
  it('reads a request DeepSeek fenced as a code block, with or without a preamble', () => {
    for (const reply of [
      '```json\n' + envelope([call]) + '\n```',
      '```\n' + envelope([call]) + '\n```',
      `Next, the file.\n\n\`\`\`json\n${envelope([call])}\n\`\`\``,
      `Next.\n\`\`\`json\n${envelope([call])}\n\`\`\`\n\n${GOAL_CONTINUE_MARKER}`
    ]) expect(parseDeepSeekReply(reply, allowed), reply).toEqual({ kind: 'tool_proposals', calls: [call] });
    // Prose after the fence still makes it an example, not a request; so does a fence that never opened.
    expect(parseDeepSeekReply('```json\n' + envelope([call]) + '\n```\nLike that.', allowed).kind).toBe('text');
    expect(parseDeepSeekReply(`Here:\n${envelope([call])}\n\`\`\``, allowed).kind).toBe('text');
  });
  it('accepts a Goal marker after a tool envelope without turning it into an answer', () => {
    for (const marker of [GOAL_CONTINUE_MARKER, GOAL_COMPLETE_MARKER]) {
      expect(parseDeepSeekReply(`${envelope([call])}\n\n${marker}`, allowed))
        .toEqual({ kind: 'tool_proposals', calls: [call] });
    }
    // Ordinary trailing prose still makes the same envelope quoted text, not a request.
    expect(parseDeepSeekReply(`${envelope([call])}\n\nThat is all.`, allowed).kind).toBe('text');
  });
  it('closes a request DeepSeek cut off before its last brackets, and never passes a broken one as an answer', () => {
    const agents = new Set(['agents']);
    const spawn = { id: 'spawn-1', name: 'agents', arguments: { action: 'spawn', workers: [{ label: 'Local commands', task: 'Run pwd.' }] } };
    const full = envelope([spawn]);
    // The live reply ended at `}]}}`: the calls array and the envelope were never closed.
    const cut = full.slice(0, -2);
    expect(cut.endsWith('}]}}')).toBe(true);
    expect(parseDeepSeekReply(`I'll spawn a worker and have it run five local commands.\n\n${cut}`, agents))
      .toEqual({ kind: 'tool_proposals', calls: [spawn] });
    expect(parseDeepSeekReply('```json\n' + cut + '\n```', agents)).toEqual({ kind: 'tool_proposals', calls: [spawn] });
    // Cut inside a string value: it cannot be closed safely, so the model is asked again.
    expect(parseDeepSeekReply(`On it.\n\n${full.slice(0, full.indexOf('Run pwd') + 3)}`, agents).kind).toBe('invalid_tool_proposals');
  });
  it('leaves an envelope quoted inside an answer as text', () => {
    for (const prose of [
      `Here is the request: ${envelope([call])} — want me to run it?`,
      `${envelope([call])}\n${envelope([call])}`,
      `${'x'.repeat(2_500)}\n${envelope([call])}`
    ]) {
      expect(parseDeepSeekReply(prose, allowed)).toEqual({ kind: 'text', text: prose });
    }
  });
  it('rejects unknown tools, repeated identities and malformed arguments', () => {
    for (const calls of [[{ ...call, name: 'other' }], [call, call], [{ ...call, arguments: [] }], []]) {
      expect(parseDeepSeekReply(envelope(calls), allowed).kind).toBe('invalid_tool_proposals');
    }
  });
  it('accepts the page’s native DSML tool-call markup', () => {
    const mark = '\uFF5C\uFF5CDSML\uFF5C\uFF5C';
    const native = [
      `<${mark} calls>`,
      `<${mark} invoke name="read">`,
      `<${mark} parameter name="path" string="true">hello.ts</${mark} parameter>`,
      `</${mark} invoke>`,
      `</${mark} calls>`
    ].join('\n');
    expect(parseDeepSeekReply(native, allowed)).toEqual({
      kind: 'tool_proposals',
      calls: [{ id: 'native-1', name: 'read', arguments: { path: 'hello.ts' } }]
    });
    expect(parseDeepSeekReply(native.replace('name="read"', 'name="other"'), allowed).kind)
      .toBe('invalid_tool_proposals');
    // Real builds break the closing tag; the opening still proves one call.
    expect(parseDeepSeekReply(native.replace(`</${mark} invoke>`, ''), allowed))
      .toEqual({ kind: 'tool_proposals', calls: [{ id: 'native-1', name: 'read', arguments: { path: 'hello.ts' } }] });
  });
  // Seen in a real chat: the wrapper is dropped and the reply opens straight at the invoke.
  it('runs native DSML that has no calls wrapper, and still refuses an unknown tool in it', () => {
    const mark = '｜｜DSML｜｜';
    const bare = `Reading.\n\n<${mark} invoke name="read">\n<${mark} parameter name="path" string="true">a.ts</${mark} parameter>\n</${mark} invoke>`;
    expect(parseDeepSeekReply(bare, allowed)).toEqual({ kind: 'tool_proposals', calls: [{ id: 'native-1', name: 'read', arguments: { path: 'a.ts' } }] });
    expect(parseDeepSeekReply(bare.replace('name="read"', 'name="other"'), allowed).kind).toBe('invalid_tool_proposals');
    expect(parseDeepSeekReply('Write <invoke name="x"> in the template.', allowed).kind).toBe('text');
  });
  it('recovers an envelope whose opening brace was replaced by the native control token', () => {
    const corrupted = '<｜type":"tool_calls","calls":[{"id":"pwd-call","name":"exec_command","arguments":{"cmd":"pwd","workdir":"/moneymaker"}}]}';
    expect(parseDeepSeekReply(corrupted, allowed)).toEqual({
      kind: 'tool_proposals',
      calls: [{ id: 'pwd-call', name: 'exec_command', arguments: { cmd: 'pwd', workdir: '/moneymaker' } }]
    });
    // The same damaged head with the brace present is still the model's envelope.
    expect(parseDeepSeekReply(corrupted.replace('<｜type', '<｜{"type'), allowed))
      .toEqual({ kind: 'tool_proposals', calls: [{ id: 'pwd-call', name: 'exec_command', arguments: { cmd: 'pwd', workdir: '/moneymaker' } }] });
    // A control token that is not an envelope remains ordinary text.
    expect(parseDeepSeekReply('<｜type":"answer"', allowed).kind).toBe('text');
  });

  it('recovers native markup with broken closing tags, repeated fields and foreign parameters', () => {
    const mark = '｜｜DSML｜｜';
    const native = [
      `<${mark} calls>`,
      `<${mark} invoke name="exec_command">`,
      `<${mark} parameter name="cmds" string="false">["ls -l /moneymaker/agents-live.txt"]</${mark} parameter>`,
      `<${mark} parameter name="workdir" string="true">/moneymaker</${mark} parameter>`,
      `</${mark} parameter name="yield_time_ms" string="false">5000</${mark} parameter>`,
      `</${mark} parameter name="tty" string="false">false</${mark} parameter>`,
      `<${mark} parameter name="timeout_seconds" string="false">10</${mark} parameter>`,
      `<${mark} parameter name="sandbox_policy" string="false">{"type":"danger"}</${mark} parameter>`,
      `</${mark} parameter name="workdir" string="true">/elsewhere</${mark} parameter>`,
      `<`
    ].join('\n');
    const keys = new Map([['exec_command', new Set(['cmds', 'workdir', 'yield_time_ms', 'tty'])]]);
    expect(parseDeepSeekReply(native, allowed, keys)).toEqual({
      kind: 'tool_proposals',
      calls: [{ id: 'native-1', name: 'exec_command', arguments: {
        cmds: ['ls -l /moneymaker/agents-live.txt'], workdir: '/moneymaker' } }]
    });
  });
  it('accepts the model’s native <tool_calls> JSON markup', () => {
    const native = `I'll start a worker.\n<tool_calls>\n${JSON.stringify([call])}\n</tool_calls>`;
    expect(parseDeepSeekReply(native, allowed)).toEqual({ kind: 'tool_proposals', calls: [call] });
    expect(parseDeepSeekReply(`<tool_calls>[{"id":"x","name":"other","arguments":{}}]</tool_calls>`, allowed).kind)
      .toBe('invalid_tool_proposals');
    expect(parseDeepSeekReply('<tool_calls>not json</tool_calls>', allowed).kind).toBe('invalid_tool_proposals');
  });
  it('accepts one or more singular <tool_call> blocks without ids', () => {
    const one = '<tool_call>\n{"name":"read","arguments":{"path":"hello.ts"}}\n</tool_call>';
    expect(parseDeepSeekReply(one, allowed)).toEqual({
      kind: 'tool_proposals', calls: [{ id: 'native-1', name: 'read', arguments: { path: 'hello.ts' } }]
    });
    const two = `${one}\n${one.replace('hello.ts', 'other.ts')}`;
    expect(parseDeepSeekReply(two, allowed)).toEqual({
      kind: 'tool_proposals',
      calls: [
        { id: 'native-1', name: 'read', arguments: { path: 'hello.ts' } },
        { id: 'native-2', name: 'read', arguments: { path: 'other.ts' } }
      ]
    });
    expect(parseDeepSeekReply('<tool_call>{"name":"other","arguments":{}}</tool_call>', allowed).kind)
      .toBe('invalid_tool_proposals');
  });
  it('treats the page’s native tool refusal as a failed request, not an answer', () => {
    const refusal = '<tool_result>\n<tool_use_error>Error formatting tool call: Expected tool name to be one of the tool names listed below. The available tools are: agents, apply_patch. Tool "search" is not available.</tool_use_error>\n</tool_result>';
    expect(parseDeepSeekReply(refusal, allowed)).toEqual({ kind: 'invalid_tool_proposals', reason: 'This page has no native tools.' });
  });
  it('describes the supplied catalog without claiming tool execution', () => {
    const instructions = buildDeepSeekToolInstructions([{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }]);
    expect(instructions).toContain('"name":"read"');
    expect(instructions).toContain('Wait for each result');
  });
  it('forbids app virtual paths inside exec_command text and omits that rule without it', () => {
    const shell = buildDeepSeekToolInstructions([{ name: 'exec_command', description: 'Run a command', inputSchema: { type: 'object' } }]);
    expect(shell).toContain('pass an app virtual path only as workdir');
    expect(shell).toContain('never inside cmd or cmds');
    expect(shell).toContain('never repeat the virtual path inside the command');
    expect(shell).toContain('INVALID_COMMAND_PATH');
    const readOnly = buildDeepSeekToolInstructions([{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }]);
    expect(readOnly).not.toContain('INVALID_COMMAND_PATH');
  });
});
