/**
 * What the chat shows of DeepSeek's tool protocol: nothing raw. A reply's tool request already
 * appears as tool rows, so only the prose before it is shown; the app's own replies to DeepSeek
 * (tool results, a refused request, a Goal step) are not the person's words.
 *
 * Display only: the main process parses and validates requests (tool-protocol.ts).
 */

const DSML_MARK = '[|｜]{1,2}DSML[|｜]{1,2}';

/** Where a tool request begins: JSON (fenced or bare), `<tool_calls>`, DSML (with or without its `calls` wrapper), or a mangled `<{"type"…` / `<｜{"type"…`. */
const REQUEST_STARTS: readonly RegExp[] = [
  /```[a-z]*\s*\{\s*"type"\s*:\s*"tool_calls"/i,
  /\{\s*"type"\s*:\s*"tool_calls"/,
  /<tool_calls?>/i,
  new RegExp(`<${DSML_MARK}\\s*(?:function_)?calls\\s*>`, 'i'),
  new RegExp(`<${DSML_MARK}\\s*invoke\\s+name\\s*=`, 'i'),
  /<[|｜]?\s*\{?\s*"?type"?\s*:\s*"tool_calls"/i
];

/** Control markers for the app, never prose: `[[COS_GOAL:COMPLETE]]`, `[[COS_CONTEXT:12]]`, `[[/COS_CONTEXT]]`. */
const MARKER = /\[\[\/?COS_[A-Z_]+(?::[^\]\n]{0,40})?\]\]/g;

/**
 * The openings of a tool request or marker, without whitespace. A streaming answer that ends in
 * one of these (`{"ty`, a lone ```json fence, `<tool_ca`, `[[COS_GO`) is cut there, so the chat
 * never flashes half a request before it is complete enough to recognize.
 */
const PARTIAL_STARTS: readonly string[] = [
  '```json{"type":"tool_calls"', '```{"type":"tool_calls"', '{"type":"tool_calls"',
  '<tool_calls>', '<tool_call>', '<｜DSML｜calls>', '<|DSML|calls>', '<｜DSML｜function_calls>', '<|DSML|function_calls>',
  '<｜｜DSML｜｜calls>', '<||DSML||calls>', '<｜DSML｜invokename=', '<｜｜DSML｜｜invokename=', '<|DSML|invokename=', '<||DSML||invokename=',
  '<{"type":"tool_calls"', '<｜{"type":"tool_calls"', '<|{"type":"tool_calls"', '<｜"type":"tool_calls"', '<｜type":"tool_calls"', '[[COS_', '[[/COS_'
];
/** An unfinished marker after its name has started: `[[COS_GOAL:COMP`. */
const PARTIAL_MARKER = /^\[\[\/?COS_[A-Z_]*(?::[^\]\n]{0,40})?\]?$/;

/** Where a trailing, still-incomplete request or marker begins, or -1. */
function partialStart(text: string, streaming: boolean): number {
  const from = Math.max(0, text.length - 200);
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char !== '{' && char !== '`' && char !== '<' && char !== '[') continue;
    const raw = text.slice(at);
    const tail = raw.replace(/\s+/g, '');
    // A finished answer may end with a stray brace or bracket; only a streaming one is still growing.
    if (tail.length < (streaming ? 1 : 2)) continue;
    // A closing code fence is the end of a code block, never the start of a request.
    if (char === '`' && (text.slice(0, at).match(/```/g)?.length ?? 0) % 2 === 1) continue;
    if (PARTIAL_MARKER.test(raw) || PARTIAL_STARTS.some(start => start.startsWith(tail))) return at;
  }
  return -1;
}

/**
 * The prose of a DeepSeek answer, without its tool request or control markers. `streaming` is for
 * an answer still being written: its last character may yet open a request.
 */
export function deepSeekAnswerText(text: string, streaming = false): string {
  let cut = text.length;
  for (const pattern of REQUEST_STARTS) {
    const match = pattern.exec(text);
    if (match && match.index < cut) cut = match.index;
  }
  const partial = partialStart(text.slice(0, cut), streaming);
  if (partial >= 0) cut = partial;
  const prose = text.slice(0, cut).replace(MARKER, '');
  return prose === text ? text : prose.replace(/[ \t]+$/gm, '').trim();
}

export type DeepSeekAppMessage =
  | { kind: 'tool-results' }
  | { kind: 'invalid-request' }
  | { kind: 'goal-step'; objective: string }
  | { kind: 'worker-reports' };

/** Opens the app's note that tells an idle prime chat its workers have reported. */
export const WORKER_REPORTS_HEADER = 'Your workers have reported back.';

const GOAL_HEADER = 'Saved goal for this chat (the finish line):\n';

/** A message the app sent DeepSeek on the person's behalf, or null for the person's own words. */
export function deepSeekAppMessage(text: string): DeepSeekAppMessage | null {
  const start = text.trimStart();
  if (/^\{\s*"type"\s*:\s*"tool_results"/.test(start)) return { kind: 'tool-results' };
  if (start.startsWith('The tool request was not valid (')) return { kind: 'invalid-request' };
  if (start.startsWith(WORKER_REPORTS_HEADER)) return { kind: 'worker-reports' };
  if (start.startsWith(GOAL_HEADER)) {
    const objective = start.slice(GOAL_HEADER.length).split('\n\n')[0]!.trim();
    return { kind: 'goal-step', objective };
  }
  return null;
}
