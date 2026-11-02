/**
 * A shell call as a terminal shows it: the command after a `$` prompt, then its output.
 *
 * Presentation only. The recorded arguments and result stay intact; this drops the runner's
 * bookkeeping lines (chunk id, wall time, token count) that were meant for the model, and the
 * colour escapes a terminal would have drawn instead of printing.
 */
export type ShellView = { command: string; output: string; exitCode: number | null };

const HEADER_LINE = /^(?:Chunk ID: .*|Wall time: .*|Process exited with code -?\d+|Process running with session ID .*|Completed session ID: .*|Original token count: .*|Retained output \(already completed; command was not run again\):|This non-zero exit is an expected command result, not a failure\.)$/;
// CSI sequences (colours, cursor moves) and OSC titles/links.
const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function commandOf(argsText: string): string | null {
  let args: unknown;
  try { args = JSON.parse(argsText); } catch { return null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const { cmd, cmds } = args as { cmd?: unknown; cmds?: unknown };
  if (typeof cmd === 'string' && cmd.trim()) return cmd.trim();
  if (Array.isArray(cmds) && cmds.length && cmds.every(part => typeof part === 'string')) return (cmds as string[]).join('\n').trim() || null;
  return null;
}

/** The terminal view of an `exec_command` call, or null when it is not one we can read. */
export function shellView(tool: string, argsText: string, resultText: string): ShellView | null {
  if (tool !== 'exec_command') return null;
  const command = commandOf(argsText);
  if (command === null) return null;
  const lines = resultText.split('\n');
  let exitCode: number | null = null;
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === 'Output:') { start = index + 1; break; }
    if (!HEADER_LINE.test(line)) { start = 0; exitCode = null; break; }
    const exit = /^Process exited with code (-?\d+)$/.exec(line);
    if (exit) exitCode = Number(exit[1]);
  }
  const output = lines.slice(start).join('\n').replace(ESCAPES, '').replace(/\s+$/, '');
  return { command, output, exitCode };
}
