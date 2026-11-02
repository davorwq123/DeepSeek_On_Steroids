/**
 * Shared launcher for the opt-in DeepSeek live smokes.
 *
 * Copies the signed-in built-in browser partition into a throwaway Electron runtime, builds one
 * fixture against the app's own source, runs it, and keeps the diagnostic log and, on failure,
 * the fixture's session history. Cookies never stay in the workspace.
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import electron from 'electron';

/** The platform-default Electron user-data folders the app may have used. */
function profileCandidates() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'deepseek-on-steroids'));
    candidates.push(path.join(process.env.APPDATA, 'DeepSeek On Steroids'));
  }
  candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'deepseek-on-steroids'));
  candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'DeepSeek On Steroids'));
  const config = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  candidates.push(path.join(config, 'deepseek-on-steroids'));
  candidates.push(path.join(config, 'DeepSeek On Steroids'));
  return [...new Set(candidates)];
}

async function browserPartition(profile) {
  // Chromium may store the `persist:cos-browser` session partition under either its logical
  // name or the persisted directory name, depending on the platform and Electron version.
  for (const name of ['persist:cos-browser', 'cos-browser']) {
    const direct = path.join(profile, 'Partitions', name);
    try { await fs.access(direct); return direct; }
    catch { /* try the other spelling */ }
  }
  return null;
}

/** A profile path for a log or error without exposing the runner's home directory. */
function shownPath(profile) {
  const home = os.homedir();
  return profile === home ? '~' : profile.startsWith(home + path.sep) ? `~${profile.slice(home.length)}` : profile;
}

/**
 * The user-data folder and its built-in browser partition.
 *
 * Shared by both live smokes and the CI preflight, so a runner with no DeepSeek profile fails
 * before a build or a model call instead of after one. The smoke itself proves the account is
 * still signed in.
 */
export async function resolveDeepSeekProfile() {
  // An explicit profile is an instruction, not a suggestion: a typo must fail here instead of
  // silently running against whichever other account happens to be signed in on the runner.
  const configured = process.env.COS_DEEPSEEK_PROFILE?.trim();
  if (configured) {
    const profile = path.resolve(configured);
    const partition = await browserPartition(profile);
    if (partition) return { profile, partition };
    throw new Error(`COS_DEEPSEEK_PROFILE points at ${shownPath(profile)}, but its built-in browser ` +
      'partition was not found. Set it to the user-data folder containing Partitions/.');
  }
  for (const candidate of profileCandidates()) {
    const partition = await browserPartition(candidate);
    if (partition) return { profile: candidate, partition };
  }
  throw new Error('No built-in browser profile was found. Sign in to DeepSeek in the app once, quit the app, ' +
    'or point COS_DEEPSEEK_PROFILE at the user-data folder that contains Partitions/persist:cos-browser.');
}

/**
 * Runs one fixture. `fixtureEntry` is workspace-relative; `outputDir` receives the run's report,
 * log and failed session history. Returns the process exit code.
 */
export async function runDeepSeekLive({ fixtureEntry, outputDir }) {
  if (process.env.COS_DEEPSEEK_LIVE !== '1') {
    throw new Error('Set COS_DEEPSEEK_LIVE=1 to run the live DeepSeek smoke.');
  }
  for (const required of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
    await fs.access(required).catch(() => {
      throw new Error(`${required} is missing; run npm run build first.`);
    });
  }

  const { profile: sourceProfile, partition: sourcePartition } = await resolveDeepSeekProfile();

  const run = path.resolve(outputDir, randomUUID());
  // The copied cookie jar is session material: keep it outside the workspace and remove it after
  // the run, while the verification report stays under outputs/ like the other live smokes.
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-deepseek-live-'));
  // Cookies and local storage hold the DeepSeek session. Copy them before Electron starts, so the
  // throwaway runtime opens the real signed-in page while config, history and workers stay new.
  const skipCaches = /(^|[\\/])(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|GrShaderCache|ShaderCache|blob_storage)([\\/]|$)/;
  try {
    // A `persist:` session partition is stored under its bare name (`Partitions/cos-browser`).
    await fs.cp(sourcePartition, path.join(runtime, 'Partitions', 'cos-browser'), {
      recursive: true,
      filter: source => !skipCaches.test(source)
    });
  } catch (error) {
    throw new Error(`Could not copy the signed-in DeepSeek browser profile from ${shownPath(sourceProfile)}. ` +
      `Quit DeepSeek On Steroids and retry. (${error instanceof Error ? error.message : String(error)})`);
  }
  for (const name of ['Local State', 'Preferences']) {
    await fs.copyFile(path.join(sourceProfile, name), path.join(runtime, name)).catch(() => {});
  }
  console.log(`Using the DeepSeek sign-in from ${shownPath(sourceProfile)} in an isolated runtime.`);

  const fixture = path.join(run, 'fixture.cjs');
  await build({
    entryPoints: [fixtureEntry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    outfile: fixture
  });
  const childEnv = { ...process.env };
  // Electron's own binary re-enters as Node when this is inherited, which quietly stops app.whenReady.
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete childEnv[key];
  const child = spawn(electron, [fixture, run, runtime], { windowsHide: true, stdio: 'inherit', env: childEnv });
  const code = await new Promise(resolve => {
    child.on('error', error => { console.error(error); resolve(1); });
    child.on('exit', status => resolve(status ?? 1));
  });
  // Keep the diagnostic log and the run's own session history (never the copied cookie jar)
  // after a failure.
  await fs.copyFile(path.join(runtime, 'app.log'), path.join(run, 'app.log')).catch(() => {});
  if (code !== 0) {
    await fs.cp(path.join(runtime, 'sessions'), path.join(run, 'sessions'), { recursive: true }).catch(() => {});
  }
  await fs.rm(runtime, { recursive: true, force: true }).catch(() => {});
  const failed = code !== 0 || await fs.access(path.join(run, 'failure.json')).then(() => true, () => false);
  if (failed) {
    console.error(`Live DeepSeek smoke failed. Report: ${path.join(run, 'failure.json')}`);
    console.error(`App log: ${path.join(run, 'app.log')}`);
    return code || 1;
  }
  console.log(`Live DeepSeek smoke passed. Report: ${path.join(run, 'verification.json')}`);
  return 0;
}
