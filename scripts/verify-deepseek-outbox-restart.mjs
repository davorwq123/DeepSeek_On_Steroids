/**
 * Restart smoke: a failed outbox row that already carries a message id and delivery time must
 * settle to sent when the app loads it, without a browser page and without a second send.
 *
 * The smoke seeds the row through the production durable writer, starts a real Electron process
 * that loads the outbox, then starts a second process against the same user-data folder. It needs
 * no DeepSeek account and spends no provider usage, so it is not part of the opt-in live smokes.
 *
 *   npm run smoke:deepseek:outbox
 *
 * The fixture deliberately uses the production outbox/store owners without the app window or
 * built-in browser: Setup's sign-in probe opens a DeepSeek page at startup, so a page count in the
 * full app could not tell whether the outbox itself opened one.
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import electron from 'electron';

const run = path.resolve('outputs/deepseek-outbox-restart', randomUUID());
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-outbox-restart-'));
const fixture = path.join(run, 'fixture.cjs');
const childEnv = { ...process.env };
// Electron's own binary re-enters as Node when this is inherited, which quietly stops app.whenReady.
for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete childEnv[key];

async function copyForDiagnostics(source, target) {
  await fs.copyFile(source, target).catch(() => undefined);
}

async function launch(phase) {
  const child = spawn(electron, [fixture, run, runtime, phase], { windowsHide: true, stdio: 'inherit', env: childEnv });
  const code = await new Promise(resolve => {
    child.on('error', error => { console.error(error); resolve(1); });
    child.on('exit', status => resolve(status ?? 1));
  });
  await copyForDiagnostics(path.join(runtime, 'state', 'session-input.json'), path.join(run, `state-${phase}.json`));
  if (code !== 0) throw new Error(`${phase} launch exited with ${code}`);
  let report;
  try {
    report = JSON.parse(await fs.readFile(path.join(run, `${phase}.json`), 'utf8'));
  } catch {
    throw new Error(`${phase} launch did not write its report`);
  }
  if (!report.ok) throw new Error(`${phase} launch reported failure: ${report.error ?? 'unknown error'}`);
  return report;
}

try {
  await fs.mkdir(run, { recursive: true });
  await fs.mkdir(runtime, { recursive: true });
  await build({
    entryPoints: ['scripts/fixtures/deepseek-outbox-restart.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    outfile: fixture
  });

  const seed = await launch('seed');
  const first = await launch('first');
  const second = await launch('second');
  await copyForDiagnostics(path.join(runtime, 'state', 'session-input.json'), path.join(run, 'state-after.json'));
  const verification = {
    ok: true,
    seed: { rows: seed.rows, checks: seed.checks },
    first: { checks: first.checks, before: first.before, after: first.after,
      webContentsCreated: first.webContentsCreated, webContentsOpen: first.webContentsOpen,
      pendingBrowserInputs: first.pendingBrowserInputs },
    second: { checks: second.checks, before: second.before, after: second.after,
      webContentsCreated: second.webContentsCreated, webContentsOpen: second.webContentsOpen,
      pendingBrowserInputs: second.pendingBrowserInputs }
  };
  await fs.writeFile(path.join(run, 'verification.json'), JSON.stringify(verification, null, 2), 'utf8');
  console.log(`Outbox restart smoke passed. Report: ${path.join(run, 'verification.json')}`);
} catch (error) {
  const failure = { ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(run, 'failure.json'), JSON.stringify(failure, null, 2), 'utf8').catch(() => undefined);
  await copyForDiagnostics(path.join(runtime, 'state', 'session-input.json'), path.join(run, 'state-failure.json'));
  console.error(`Outbox restart smoke failed. Report: ${path.join(run, 'failure.json')}`);
  process.exitCode = 1;
} finally {
  await fs.rm(runtime, { recursive: true, force: true }).catch(() => undefined);
}
