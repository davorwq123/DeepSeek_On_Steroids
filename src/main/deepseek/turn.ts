/**
 * One DeepSeek turn where the model asked for local tools.
 *
 * The reply is text, so it is a proposal, never authority: this module validates the
 * envelope against the catalog, runs each accepted call in order, and builds the single
 * message that carries the exact results back. It does not record or deliver anything —
 * the caller records the assistant message and files the continuation through the app's
 * existing outbox, so history and the conversation keep one owner each.
 */

import {
  parseDeepSeekReply,
  type DeepSeekToolDescriptor,
  type DeepSeekToolProposal
} from './tool-protocol.js';

/** The app's own message ceiling is 96,000 characters; leave room for protocol framing. */
export const DEEPSEEK_CONTINUATION_CHAR_LIMIT = 80_000;
const MAX_RESULT_CHARS = 40_000;
/** Envelope JSON escapes newlines and quotes, so budget roughly twice the raw text. */
const ENVELOPE_OVERHEAD = 4_000;

export interface DeepSeekCallOutcome {
  id: string;
  name: string;
  isError: boolean;
  /** The result's size before any bounding, for the activity line. */
  chars: number;
}

/** Accepted results retained by the reply owner while delivery or ownership reads retry. */
export interface DeepSeekCompletedCall {
  text: string;
  isError: boolean;
  chars: number;
}

export type DeepSeekTurnOutcome =
  | { status: 'answer'; text: string }
  | { status: 'stopped' }
  | { status: 'tools'; calls: DeepSeekCallOutcome[]; continuation: string }
  | { status: 'invalid'; reason: string; continuation: string };

export interface DeepSeekTurnOptions {
  tools: readonly DeepSeekToolDescriptor[];
  execute: (call: DeepSeekToolProposal) => Promise<{ text: string; isError: boolean }>;
  maxContinuationChars?: number;
  /** Recheck the exact turn before each call and before publishing its continuation. */
  current?: () => Promise<boolean>;
  /** One immutable reply's call ids. Text is bounded to this reply's result budget. */
  completedCalls?: Map<string, DeepSeekCompletedCall>;
}

/** UTF-16 safe: never split a surrogate pair, so a cut cannot invent a broken character. */
function boundText(text: string, max: number, chars = text.length): string {
  if (chars <= max) return text;
  const cut = max > 0 && /[\uD800-\uDBFF]/.test(text[max - 1] ?? '') ? max - 1 : max;
  return `${text.slice(0, Math.max(0, cut))}\n… truncated by the app at ${cut} of ${chars} characters`;
}

function resultBudget(calls: number, maxChars: number): number {
  const room = Math.max(1_024, maxChars - ENVELOPE_OVERHEAD);
  return Math.max(512, Math.min(MAX_RESULT_CHARS, Math.floor(room / Math.max(1, calls * 2))));
}

function toolResultsEnvelope(
  calls: readonly ({ call: DeepSeekToolProposal } & DeepSeekCompletedCall)[],
  budget: number
): string {
  const results = calls.map(({ call, text, isError, chars }) => ({
    id: call.id,
    name: call.name,
    ok: !isError,
    content: boundText(text, budget, chars)
  }));
  return [
    JSON.stringify({ type: 'tool_results', results }),
    '',
    'The app ran those calls and recorded them. Continue the task. If you need another tool, reply with only a {"type":"tool_calls","calls":[...]} object using the available tools; otherwise give the normal answer. Do not claim a result you were not given.'
  ].join('\n');
}

function invalidCorrection(reason: string, tools: readonly DeepSeekToolDescriptor[]): string {
  const names = tools.map(tool => tool.name).join(', ') || 'none';
  return [
    `The tool request was not valid (${reason}). No tool ran.`,
    `Reply with only {"type":"tool_calls","calls":[{"id":"unique-id","name":"tool_name","arguments":{}}]} using one of: ${names}.`,
    'If no tool is needed, answer normally.'
  ].join('\n');
}

export async function runDeepSeekTurn(reply: string, options: DeepSeekTurnOptions): Promise<DeepSeekTurnOutcome> {
  const maxChars = options.maxContinuationChars ?? DEEPSEEK_CONTINUATION_CHAR_LIMIT;
  const allowed = new Set(options.tools.map(tool => tool.name));
  // Native markup sometimes carries another agent's whole schema. Only a tool's declared
  // arguments may reach the kernel's strict validation, or a real request is refused for
  // fields the model invented around it.
  const argumentKeys = new Map(options.tools.map(tool => {
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> } | null)?.properties;
    return [tool.name, new Set(Object.keys(properties ?? {}))] as const;
  }));
  const parsed = parseDeepSeekReply(reply, allowed, argumentKeys);
  if (parsed.kind === 'text') return { status: 'answer', text: parsed.text };
  if (parsed.kind === 'invalid_tool_proposals') {
    return { status: 'invalid', reason: parsed.reason, continuation: invalidCorrection(parsed.reason, options.tools) };
  }

  const outcomes: Array<{ call: DeepSeekToolProposal } & DeepSeekCompletedCall> = [];
  const calls: DeepSeekCallOutcome[] = [];
  const budget = resultBudget(parsed.calls.length, maxChars);
  // Sequentially, in the order requested: the protocol promises a result before the next
  // step, and a later call may depend on what an earlier one changed.
  for (const call of parsed.calls) {
    if (options.current && !await options.current()) return { status: 'stopped' };
    let completed = options.completedCalls?.get(call.id);
    if (!completed) {
      let text: string;
      let isError: boolean;
      try {
        const result = await options.execute(call);
        text = result.text;
        isError = result.isError;
      } catch (error) {
        text = `The app could not run this tool: ${error instanceof Error ? error.message : String(error)}`;
        isError = true;
      }
      completed = { text: text.slice(0, budget), isError, chars: text.length };
      // Publish before any further await: a failed ownership read cannot erase a call
      // that already ran. A retry uses its exact result and executes only later calls.
      options.completedCalls?.set(call.id, completed);
    }
    outcomes.push({ call, ...completed });
    calls.push({ id: call.id, name: call.name, isError: completed.isError, chars: completed.chars });
  }
  if (options.current && !await options.current()) return { status: 'stopped' };

  let continuation = toolResultsEnvelope(outcomes, budget);
  if (continuation.length > maxChars) {
    continuation = toolResultsEnvelope(outcomes, 512);
  }
  if (continuation.length > maxChars) {
    // The calls did run and are already recorded; this only refuses to deliver an envelope
    // the app cannot send whole. Rebuilding a smaller one would silently drop a result.
    return {
      status: 'invalid',
      reason: 'The tool results exceeded the message limit.',
      continuation: 'The app ran the requested tools but could not send their combined results in one message. Ask for less output per call (smaller reads, narrower commands) and try again.'
    };
  }
  return { status: 'tools', calls, continuation };
}
