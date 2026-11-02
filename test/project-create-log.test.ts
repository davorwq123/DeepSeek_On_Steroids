import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { randomUUID } from 'node:crypto';
import { addProject, armProjectCreate, claimProjectCreate, completeProjectCreate, failProjectCreate, pendingProjectCreates, retryProjectCreate } from '../src/main/projects.js';
import { validateNewRoot } from '../src/main/sandbox.js';

const logged = vi.hoisted(() => [] as string[]);
vi.mock('../src/main/logger.js', () => ({
  logInfo: (line: string) => { logged.push(line); }, logWarn: (line: string) => { logged.push(line); }, logError: (line: string) => { logged.push(line); }
}));

// DeepSeek has no native Projects: adding a folder and reading an old request stay silent.
let directory: string, approved: string;
beforeEach(async () => {
  logged.length = 0;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-project-log-'));
  approved = path.join(directory, 'approved');
  await fs.mkdir(path.join(approved, 'Kunden'), { recursive: true });
  approved = await validateNewRoot(approved, []);
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
});
afterEach(async () => { resetSessionStoreForTests(); resetDurableForTests(); await fs.rm(directory, { recursive: true, force: true }); });

it('never logs a native Project creation when adding a folder', async () => {
  const project = await addProject(path.join(approved, 'Kunden'));
  expect(project).not.toHaveProperty('chatgpt');
  expect(await pendingProjectCreates()).toEqual([]);
  expect(logged).toEqual([]);
});

it('ignores an old creation request without logging or advancing its native Project', async () => {
  const project = await addProject(path.join(approved, 'Kunden'));
  const request = randomUUID();
  await writeDurableNow('projects', [{ ...project, chatgpt: { state: 'requested', requestId: request, updatedAt: 0 } }]);
  logged.length = 0;
  expect(await pendingProjectCreates()).toEqual([]);
  expect(await claimProjectCreate(request, 'page')).toBe(false);
  expect(await armProjectCreate(request, 'page')).toBe(false);
  expect(await completeProjectCreate(request, 'page', `g-p-${'a'.repeat(32)}`)).toBe(false);
  expect(await failProjectCreate(request, 'page', 'No native Projects')).toBe(false);
  expect(await retryProjectCreate(project.id)).toBeNull();
  expect(logged).toEqual([]);
});
