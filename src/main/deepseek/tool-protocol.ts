import { GOAL_COMPLETE_MARKER, GOAL_CONTINUE_MARKER } from '../../shared/goal-templates.js';

/**
 * DeepSeek Web has no demonstrated native tool-call channel. These envelopes are
 * text produced by the model, not authority to execute a tool. The owner of a
 * conversation must validate, authorize and record each accepted proposal.
 */
export interface DeepSeekToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface DeepSeekToolProposal {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ParsedDeepSeekReply =
  | { kind: 'text'; text: string }
  | { kind: 'tool_proposals'; calls: DeepSeekToolProposal[] }
  | { kind: 'invalid_tool_proposals'; reason: string };

const MAX_REPLY_BYTES = 1_000_000;
const MAX_CALLS = 16;
/**
 * DeepSeek Web's own tool-call markup. It uses full-width bars around the DSML name, and
 * models sometimes emit it even when the prompt asks for the JSON envelope. It is still only
 * a proposal: every call crosses the same name, identity and argument validation below.
 */
const DSML_MARK = '[|｜]{1,2}DSML[|｜]{1,2}';
// The `calls` wrapper is sometimes dropped and the reply opens straight at an `invoke`.
const DSML_CALLS = new RegExp(`<${DSML_MARK}\\s*(?:calls\\s*>|invoke\\s+name\\s*=)`, 'i');
const DSML_INVOKE = new RegExp(`<${DSML_MARK}\\s*invoke\\s+name\\s*=\\s*"([^"]+)"\\s*>([\\s\\S]*?)<\\/${DSML_MARK}\\s*invoke\\s*>`, 'gi');
const DSML_PARAM = new RegExp(`<${DSML_MARK}\\s*parameter\\s+name\\s*=\\s*"([^"]+)"(?:\\s+string\\s*=\\s*"([^"]*)")?\\s*>([\\s\\S]*?)<\\/${DSML_MARK}\\s*parameter\\s*>`, 'gi');
/**
 * The same markup as some DeepSeek builds actually emit it: the marker word is not always
 * `DSML` (a tokenizer build writes `｜DSML｜`), and closing tags lose their name or gain attributes
 * (`</｜｜ parameter name="tty" …>`). Repeated parameters are common when the model degenerates.
 * Every extracted call still crosses the same name and argument validation below.
 */
const OPEN_MARK = '[|｜]{1,2}[A-Za-z0-9]{1,16}[|｜]{1,2}';
const OPEN_CALLS = new RegExp(`<${OPEN_MARK}\\s*(?:calls\\s*>|invoke\\s+name\\s*=)`, 'i');
const OPEN_INVOKE = new RegExp(`<${OPEN_MARK}\\s*invoke\\s+name\\s*=\\s*"([^"]+)"[^>]*>`, 'gi');
const OPEN_PARAM = new RegExp(`<${OPEN_MARK}\\s*parameter\\s+name\\s*=\\s*"([^"]+)"(?:\\s+string\\s*=\\s*"([^"]*)")?[^>]*>([\\s\\S]*?)<\\/`, 'gi');

/** Keep only arguments the tool actually declares; a degenerating model dumps foreign fields. */
function declaredArguments(name: string, args: Record<string, unknown>, argumentKeys?: ReadonlyMap<string, ReadonlySet<string>>): Record<string, unknown> {
  const keys = argumentKeys?.get(name);
  if (!keys?.size) return args;
  return Object.fromEntries(Object.entries(args).filter(([key]) => keys.has(key)));
}

/** Native markup whose tags are malformed enough for the strict reader, or null. */
function parseLooseNative(text: string, allowedNames: ReadonlySet<string>, argumentKeys?: ReadonlyMap<string, ReadonlySet<string>>): ParsedDeepSeekReply | null {
  if (!OPEN_CALLS.test(text)) return null;
  const openings = [...text.matchAll(new RegExp(OPEN_INVOKE.source, 'gi'))];
  if (!openings.length) return { kind: 'invalid_tool_proposals', reason: 'Invalid number of calls.' };
  const parsed: DeepSeekToolProposal[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < openings.length; index += 1) {
    const opening = openings[index]!;
    const name = opening[1]!;
    if (!allowedNames.has(name)) return { kind: 'invalid_tool_proposals', reason: 'Unknown tool.' };
    const body = text.slice((opening.index ?? 0) + opening[0].length,
      index + 1 < openings.length ? openings[index + 1]!.index : undefined);
    const args: Record<string, unknown> = {};
    let parameter: RegExpExecArray | null;
    const parameters = new RegExp(OPEN_PARAM.source, 'gi');
    while ((parameter = parameters.exec(body))) {
      const key = parameter[1]!;
      // The first value wins: a degenerating model repeats the whole schema afterwards.
      if (key in args) continue;
      const raw = dsmlText((parameter[3] ?? '').replace(/<\/[\s\S]*$/, ''));
      if (parameter[2] === 'false') {
        try { args[key] = JSON.parse(raw); }
        catch { return { kind: 'invalid_tool_proposals', reason: 'Invalid tool arguments.' }; }
      } else {
        args[key] = raw;
      }
    }
    const declared = declaredArguments(name, args, argumentKeys);
    const signature = `${name}\u0000${JSON.stringify(declared)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    parsed.push({ id: `native-${parsed.length + 1}`, name, arguments: declared });
    if (parsed.length > MAX_CALLS) return { kind: 'invalid_tool_proposals', reason: 'Invalid number of calls.' };
  }
  if (!parsed.length) return { kind: 'invalid_tool_proposals', reason: 'Invalid number of calls.' };
  return { kind: 'tool_proposals', calls: parsed };
}

function dsmlText(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
}

/** Native markup, or null when the reply is not that format at all. */
function parseDsmlReply(text: string, allowedNames: ReadonlySet<string>, argumentKeys?: ReadonlyMap<string, ReadonlySet<string>>): ParsedDeepSeekReply | null {
  if (!DSML_CALLS.test(text)) return null;
  const invokes = [...text.matchAll(new RegExp(DSML_INVOKE.source, 'gi'))];
  if (invokes.length < 1 || invokes.length > MAX_CALLS) {
    return { kind: 'invalid_tool_proposals', reason: 'Invalid number of calls.' };
  }
  const parsed: DeepSeekToolProposal[] = [];
  for (const invoke of invokes) {
    const name = invoke[1]!;
    if (!allowedNames.has(name)) return { kind: 'invalid_tool_proposals', reason: 'Unknown tool.' };
    const args: Record<string, unknown> = {};
    let parameter: RegExpExecArray | null;
    const parameters = new RegExp(DSML_PARAM.source, 'gi');
    while ((parameter = parameters.exec(invoke[2] ?? ''))) {
      const key = parameter[1]!;
      const raw = dsmlText(parameter[3] ?? '');
      if (parameter[2] === 'false') {
        try { args[key] = JSON.parse(raw); }
        catch { return { kind: 'invalid_tool_proposals', reason: 'Invalid tool arguments.' }; }
      } else {
        args[key] = raw;
      }
    }
    parsed.push({ id: `native-${parsed.length + 1}`, name, arguments: declaredArguments(name, args, argumentKeys) });
  }
  return { kind: 'tool_proposals', calls: parsed };
}

/**
 * The model's own Qwen-style tool markup.
 *
 * DeepSeek models emit this natively in several shapes: `<tool_calls>` around a JSON array,
 * around one object, or one or more `<tool_call>` blocks each holding a single call. All of them
 * are the same proposal the JSON envelope carries, so they cross the same validation; a call
 * without an id gets a local one, and an unreadable block is refused rather than answered.
 */
const XML_CALLS = /<tool_calls>([\s\S]*?)<\/tool_calls>/i;
const XML_CALL = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

function normalizedXmlCalls(value: unknown): unknown[] | null {
  const rows = Array.isArray(value) ? value
    : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).calls)
      ? (value as Record<string, unknown>).calls as unknown[]
      : value && typeof value === 'object' && typeof (value as Record<string, unknown>).name === 'string'
        ? [value] : null;
  if (!rows || rows.length < 1 || rows.length > MAX_CALLS) return null;
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const call = row as Record<string, unknown>;
    const id = typeof call.id === 'string' && call.id ? call.id : `native-${index + 1}`;
    return { ...call, id };
  });
}

function parseXmlToolCalls(text: string, allowedNames: ReadonlySet<string>): ParsedDeepSeekReply | null {
  // Singular blocks first: a reply can carry several, and each is one call.
  const singles = [...text.matchAll(new RegExp(XML_CALL.source, 'gi'))];
  let calls: unknown[] | null = null;
  if (singles.length) {
    calls = [];
    for (const single of singles) {
      let parsed: unknown;
      try { parsed = JSON.parse((single[1] ?? '').trim()); } catch {
        return { kind: 'invalid_tool_proposals', reason: 'Invalid tool request.' };
      }
      const normalized = normalizedXmlCalls(parsed);
      if (!normalized) return { kind: 'invalid_tool_proposals', reason: 'Invalid tool request.' };
      calls.push(...normalized);
    }
  } else {
    const block = XML_CALLS.exec(text);
    if (!block) return null;
    let parsed: unknown;
    try { parsed = JSON.parse((block[1] ?? '').trim()); } catch {
      return { kind: 'invalid_tool_proposals', reason: 'Invalid tool request.' };
    }
    calls = normalizedXmlCalls(parsed);
  }
  if (!calls) return { kind: 'invalid_tool_proposals', reason: 'Invalid tool request.' };
  // Local ids must stay unique when several blocks each brought their own numbering.
  const seen = new Set<string>();
  calls = calls.map((row, index) => {
    const call = row as Record<string, unknown>;
    let id = typeof call.id === 'string' && call.id && !seen.has(call.id) ? call.id : `native-${index + 1}`;
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    return { ...call, id };
  });
  return validateEnvelope({ type: 'tool_calls', calls }, allowedNames) ??
    { kind: 'invalid_tool_proposals', reason: 'Invalid tool request.' };
}

export function buildDeepSeekToolInstructions(tools: readonly DeepSeekToolDescriptor[]): string {
  return [
    'Local tools can be requested through the workspace. This page has no native tool channel: never write native tool markup (no <｜…｜ calls>, DSML, <tool_call>, or a browser/search tool). To request tools, start your reply with the { character and write only this JSON object — no introduction, no code fence:',
    '{"type":"tool_calls","calls":[{"id":"unique-call-id","name":"tool_name","arguments":{}}]}',
    'Use only listed tools. Wait for each result before claiming that an action happened. If no tool is needed, answer normally.',
    ...(tools.some(tool => tool.name === 'exec_command')
      ? ['exec_command: pass an app virtual path only as workdir, never inside cmd or cmds. With workdir set to the project’s virtual path, use a relative command such as "rg --files ."; never repeat the virtual path inside the command. A virtual path inside shell command text is refused with INVALID_COMMAND_PATH.']
      : []),
    `Available tools: ${JSON.stringify(tools)}`
  ].join('\n');
}

function validateEnvelope(value: unknown, allowedNames: ReadonlySet<string>): ParsedDeepSeekReply | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).type !== 'tool_calls') return null;
  const calls = (value as Record<string, unknown>).calls;
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > MAX_CALLS) return { kind: 'invalid_tool_proposals', reason: 'Invalid number of calls.' };
  const ids = new Set<string>();
  const parsed: DeepSeekToolProposal[] = [];
  for (const value of calls) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid_tool_proposals', reason: 'Invalid call.' };
    const call = value as Record<string, unknown>;
    if (typeof call.id !== 'string' || !call.id || call.id.length > 128 || ids.has(call.id)) return { kind: 'invalid_tool_proposals', reason: 'Invalid or repeated call identity.' };
    if (typeof call.name !== 'string' || !allowedNames.has(call.name)) return { kind: 'invalid_tool_proposals', reason: 'Unknown tool.' };
    if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return { kind: 'invalid_tool_proposals', reason: 'Invalid tool arguments.' };
    ids.add(call.id);
    parsed.push({ id: call.id, name: call.name, arguments: call.arguments as Record<string, unknown> });
  }
  return { kind: 'tool_proposals', calls: parsed };
}

/**
 * The model often introduces its envelope instead of starting with it ("I'll create the
 * file…\n{…}"), which would otherwise turn a real tool request into a plain answer that
 * only claims the work happened. Find one embedded envelope, but only when the reply is
 * essentially just that request: one envelope, little surrounding prose, nothing after it.
 * An accepted envelope crosses the same validation as a bare one.
 */
const MAX_PREAMBLE_CHARS = 2_000;

/**
 * Some DeepSeek builds replace the envelope's opening `{"` with their native `<｜` control
 * token, leaving `<｜type":"tool_calls",...}`. The model still asked for a tool; only the
 * transport head is damaged. Rebuild exactly that head and let the normal envelope reader
 * accept it, so a malformed prefix cannot turn a real command into a final answer.
 */
function repairControlTokenEnvelope(text: string): string | null {
  if (!/^<[|｜]\s*(?:\{\s*)?"?type"?\s*:\s*"tool_calls"/i.test(text)) return null;
  const body = text.replace(/^<[|｜]\s*/, '');
  if (body.startsWith('{')) return body;
  if (body.startsWith('"')) return `{${body}`;
  return `{"${body}`;
}

/** An envelope that runs to the end of the reply with brackets left open and cannot be closed. */
const INCOMPLETE_ENVELOPE = Symbol('incomplete tool envelope');

function extractEnvelope(text: string): unknown | typeof INCOMPLETE_ENVELOPE | null {
  const marker = /\{\s*"type"\s*:\s*"tool_calls"/g;
  let found: { value: unknown; start: number; end: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text))) {
    if (found) return null;
    const start = match.index;
    const open: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') open.push(char);
      else if (char === '}' || char === ']') {
        if (open.pop() !== (char === '}' ? '{' : '[')) return null;
        if (!open.length) {
          try { found = { value: JSON.parse(text.slice(start, index + 1)), start, end: index + 1 }; }
          catch { return null; }
          break;
        }
      }
    }
    if (!found) {
      // DeepSeek sometimes stops before the envelope's last closing brackets. The request
      // still reaches the end of the reply, so close exactly what is open; if that does not
      // parse, report a broken request rather than letting it pass as a final answer.
      if (inString || !open.length) return INCOMPLETE_ENVELOPE;
      const body = text.slice(start).replace(/\s*```\s*$/, '');
      const closers = open.reverse().map(char => (char === '{' ? '}' : ']')).join('');
      if (start > MAX_PREAMBLE_CHARS) return null;
      try { return JSON.parse(body + closers); } catch { return INCOMPLETE_ENVELOPE; }
    }
    marker.lastIndex = found.end;
  }
  if (!found) return null;
  // A Goal/Loop answer is asked to end with its marker. When the model also requests a tool,
  // the marker follows the envelope; it is app protocol, not prose, and must not turn the
  // request into an answer that skips the tool.
  let tail = text.slice(found.end).trim();
  // DeepSeek usually fences its request (```json … ```): the closing fence ends that block and
  // is no more prose than the opening one.
  if (/```[a-z]*\s*$/i.test(text.slice(0, found.start)) && tail.startsWith('```')) tail = tail.slice(3).trim();
  if (tail && tail !== GOAL_COMPLETE_MARKER && tail !== GOAL_CONTINUE_MARKER) return null;
  if (text.slice(0, found.start).length > MAX_PREAMBLE_CHARS) return null;
  return found.value;
}

const INCOMPLETE_REQUEST: ParsedDeepSeekReply = { kind: 'invalid_tool_proposals', reason: 'The tool request JSON is incomplete.' };

export function parseDeepSeekReply(text: string, allowedNames: ReadonlySet<string>, argumentKeys?: ReadonlyMap<string, ReadonlySet<string>>): ParsedDeepSeekReply {
  if (Buffer.byteLength(text, 'utf8') > MAX_REPLY_BYTES) return { kind: 'invalid_tool_proposals', reason: 'Reply exceeds the supported size.' };
  // DeepSeek's own client, not the model, writes this when the model tried one of its native
  // tools (e.g. search). It is a failed tool attempt, never an answer: record it truthfully,
  // then hand the model the text protocol instead of letting the turn end on the error.
  const refusal = text.trim();
  if (refusal.startsWith('<tool_result>') && /<tool_use_error>/i.test(refusal) &&
      /is not available|error formatting tool call/i.test(refusal))
    return { kind: 'invalid_tool_proposals', reason: 'This page has no native tools.' };
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch {
    const repaired = repairControlTokenEnvelope(text.trim());
    if (repaired) {
      const embedded = extractEnvelope(repaired);
      if (embedded === INCOMPLETE_ENVELOPE) return INCOMPLETE_REQUEST;
      if (embedded !== null) return validateEnvelope(embedded, allowedNames) ?? { kind: 'text', text };
    }
    const native = parseDsmlReply(text, allowedNames, argumentKeys);
    if (native && native.kind !== 'invalid_tool_proposals') return native;
    const loose = parseLooseNative(text, allowedNames, argumentKeys);
    if (loose) return loose;
    if (native) return native;
    const xml = parseXmlToolCalls(text, allowedNames);
    if (xml) return xml;
    const embedded = extractEnvelope(text);
    if (embedded === INCOMPLETE_ENVELOPE) return INCOMPLETE_REQUEST;
    if (embedded === null) return { kind: 'text', text };
    return validateEnvelope(embedded, allowedNames) ?? { kind: 'text', text };
  }
  return validateEnvelope(value, allowedNames) ?? { kind: 'text', text };
}
