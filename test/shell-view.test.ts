import { expect, it } from 'vitest';
import { shellView } from '../src/renderer/shell-view.js';

// The runner's reply as a real chat recorded it: bookkeeping lines, then the command's output.
const RECORDED = 'Chunk ID: 01d597\nWall time: 0.0692 seconds\nProcess exited with code 0\nCompleted session ID: 2657\nOriginal token count: 63\nOutput:\n[\u001b[31mERROR\u001b[0m] - (starship::print): Under a \'dumb\' terminal (TERM=dumb).\n./fe_bounty/src/AGENTS.md\n';

it('shows a shell call as its command and what it printed, without the runner bookkeeping', () => {
  expect(shellView('exec_command', '{"workdir":"/w","cmd":"rg --files -g AGENTS.md . | head -50"}', RECORDED)).toEqual({
    command: 'rg --files -g AGENTS.md . | head -50',
    output: "[ERROR] - (starship::print): Under a 'dumb' terminal (TERM=dumb).\n./fe_bounty/src/AGENTS.md",
    exitCode: 0
  });
});

it('keeps the exit code of a failed command and joins a command list', () => {
  const failed = 'Wall time: 0.1 seconds\nProcess exited with code 2\nOutput:\nls: cannot access x';
  expect(shellView('exec_command', '{"cmds":["cd /w","ls x"]}', failed)).toEqual({ command: 'cd /w\nls x', output: 'ls: cannot access x', exitCode: 2 });
});

it('keeps an output that has no bookkeeping header whole, even one that mentions Output:', () => {
  const plain = 'hello\nOutput:\nworld';
  expect(shellView('exec_command', '{"cmd":"echo"}', plain)?.output).toBe(plain);
});

it('leaves every other tool, and unreadable arguments, to the ordinary view', () => {
  expect(shellView('read', '{"cmd":"x"}', RECORDED)).toBeNull();
  expect(shellView('exec_command', '{"cmd":', RECORDED)).toBeNull();
  expect(shellView('exec_command', '{"cmd":"  "}', RECORDED)).toBeNull();
  expect(shellView('exec_command', '{"cmds":[1]}', RECORDED)).toBeNull();
});
