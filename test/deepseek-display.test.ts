import { describe, expect, it } from 'vitest';
import { deepSeekAnswerText, deepSeekAppMessage } from '../src/shared/deepseek-display.js';
import { prependUserPrompt } from '../src/shared/user-prompt.js';

it('keeps only the prose before a tool request, in every shape DeepSeek writes one', () => {
  const json = '{"type":"tool_calls","calls":[]}';
  expect(deepSeekAnswerText(`Checking.\n${json}`)).toBe('Checking.');
  expect(deepSeekAnswerText(`Checking.\n\`\`\`json\n${json}\n\`\`\``)).toBe('Checking.');
  expect(deepSeekAnswerText('Checking.\n<tool_calls>\n[{"name":"read"}]\n</tool_calls>')).toBe('Checking.');
  expect(deepSeekAnswerText('<｜DSML｜calls><｜DSML｜invoke name="read"></｜DSML｜invoke></｜DSML｜calls>')).toBe('');
  expect(deepSeekAnswerText('<｜type":"tool_calls","calls":[]}')).toBe('');
  expect(deepSeekAnswerText(json)).toBe('');
});

// From a real chat: DeepSeek V4.1 opened its JSON request with a stray `<`, and wrote native DSML
// with doubled bars and a space before the tag name, sometimes without the `calls` wrapper.
const SEEN_DSML = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read">\n<｜｜DSML｜｜ parameter name="paths" string="false">["/w/AGENTS.md", "/w/src"]</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
const SEEN_BARE_DSML = '<｜｜DSML｜｜ invoke name="read">\n<｜｜DSML｜｜ parameter name="paths" string="false">["/w/a"]</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>';
const SEEN_STRAY = '<{"type":"tool_calls","calls":[{"id":"dirs","name":"exec_command","arguments":{"workdir":"/w","cmd":"ls -la ."}}]}';

it('hides the request shapes seen in a real DeepSeek V4.1 chat', () => {
  expect(deepSeekAnswerText(SEEN_STRAY)).toBe('');
  expect(deepSeekAnswerText(`Next, the layout.\n${SEEN_STRAY}`)).toBe('Next, the layout.');
  expect(deepSeekAnswerText(SEEN_DSML)).toBe('');
  expect(deepSeekAnswerText(`Reading both.\n\n${SEEN_BARE_DSML}`)).toBe('Reading both.');
});

it('drops control markers and leaves ordinary answers untouched', () => {
  expect(deepSeekAnswerText('Done.\n\n[[COS_GOAL:COMPLETE]]')).toBe('Done.');
  const plain = 'Use `{"type": "x"}` here.\n\n  indented code\n';
  expect(deepSeekAnswerText(plain)).toBe(plain);
});

it("tells the app's own messages from the person's words", () => {
  expect(deepSeekAppMessage('{"type":"tool_results","results":[]}\n\nContinue.')).toEqual({ kind: 'tool-results' });
  expect(deepSeekAppMessage('The tool request was not valid (bad json). No tool ran.')).toEqual({ kind: 'invalid-request' });
  expect(deepSeekAppMessage('Saved goal for this chat (the finish line):\nShip it\n\nKeep going.')).toEqual({ kind: 'goal-step', objective: 'Ship it' });
  expect(deepSeekAppMessage('please read {"type":"tool_results"} for me')).toBeNull();
  expect(deepSeekAppMessage('run the tests')).toBeNull();
});

it('leaves the protocol out of the transcript export and the sidebar line', async () => {
  const { transcriptEntries } = await import('../src/shared/markdown-export.js');
  const said = (seq: number, kind: 'user_message' | 'assistant_message', value: string) => ({
    kind, seq, origin: seq, time: seq, source: 'extension', messageId: `m${seq}`, final: true,
    message: { text: value, truncated: false, chars: value.length }
  }) as any;
  const entries = transcriptEntries([
    said(1, 'user_message', 'run the tests'),
    said(2, 'assistant_message', 'Looking.\n{"type":"tool_calls","calls":[]}'),
    said(3, 'user_message', '{"type":"tool_results","results":[]}'),
    said(4, 'assistant_message', 'All pass.\n[[COS_GOAL:COMPLETE]]')
  ]);
  expect(entries.map(entry => entry.stored.text)).toEqual(['run the tests', 'Looking.', 'All pass.']);
});

it('leaves framed and explicitly app-authored instructions out of exports without hiding real user text', async () => {
  const { transcriptEntries } = await import('../src/shared/markdown-export.js');
  const said = (seq: number, text: string, authoredText?: string) => ({
    kind: 'user_message', seq, origin: seq, time: seq, source: 'app', messageId: `m${seq}`,
    message: { text, truncated: false, chars: text.length }, ...(authoredText === undefined ? {} : { authoredText })
  }) as any;
  const entries = transcriptEntries([
    said(1, prependUserPrompt('Read the files', 'Private executor instructions')),
    said(2, prependUserPrompt('{"type":"tool_results","results":[]}', 'Protocol instructions')),
    said(3, 'Saved goal for this chat (the finish line):\nFinish it\n\nContinue.', ''),
    said(4, 'Continue the task; these are internal transport instructions.', ''),
    said(5, 'Please explain this protocol', 'Please explain this protocol')
  ]);
  expect(entries.map(entry => entry.stored.text)).toEqual(['Read the files', 'Please explain this protocol']);
});

// Stress: DeepSeek streams its answer, and the chat redraws every prefix of it. No prefix may
// show any of the protocol, and what is shown only grows: nothing flashes up and disappears.
describe('a streaming answer, prefix by prefix', () => {
  const envelope = '{"type":"tool_calls","calls":[{"id":"c1","name":"read","arguments":{"path":"src/a.ts"}}]}';
  const answers = [
    `Let me look at the file.\n${envelope}`,
    `Let me look at the file.\n\n\`\`\`json\n${envelope}\n\`\`\``,
    `Checking.\n\`\`\`\n${envelope}\n\`\`\``,
    `Here is the fix:\n\n\`\`\`ts\nconst a = { b: 1 };\n\`\`\`\n\nNow I run the tests.\n${envelope}`,
    'Reading.\n<tool_calls>\n[{"name":"read","arguments":{"path":"a"}}]\n</tool_calls>',
    'Reading.\n<｜DSML｜calls><｜DSML｜invoke name="read"></｜DSML｜invoke></｜DSML｜calls>',
    `Reading both.\n\n${SEEN_DSML}`,
    `Reading.\n${SEEN_BARE_DSML}`,
    `Next, the layout.\n${SEEN_STRAY}`,
    SEEN_STRAY,
    'All tests pass.\n\n[[COS_GOAL:COMPLETE]]',
    envelope,
    '```json\n' + envelope + '\n```'
  ];
  const leaks = /tool_calls|"type"|DSML|\[\[|COS_|```json\s*\{|\{\s*"$/;

  it.each(answers)('never shows the protocol while it streams (%#)', full => {
    const final = deepSeekAnswerText(full);
    expect(final).not.toMatch(leaks);
    let shown = '';
    for (let end = 1; end <= full.length; end += 1) {
      const view = deepSeekAnswerText(full.slice(0, end), end < full.length);
      expect(view, JSON.stringify(full.slice(0, end))).not.toMatch(leaks);
      // Monotonic: each redraw extends the last one (trailing whitespace aside) and stays within the final text.
      expect(final.startsWith(view.trimEnd()), JSON.stringify(full.slice(0, end))).toBe(true);
      expect(view.trimEnd().length).toBeGreaterThanOrEqual(shown.trimEnd().length - 1);
      shown = view;
    }
  });

  it('keeps an ordinary answer whole, closing fences, braces and brackets included', () => {
    for (const plain of ['Use this:\n\n```ts\nconst x = {};\n```', 'The set is {1, 2}', 'See [1]', 'a < b', 'Done {', 'x[']) {
      expect(deepSeekAnswerText(plain)).toBe(plain);
    }
  });
});
