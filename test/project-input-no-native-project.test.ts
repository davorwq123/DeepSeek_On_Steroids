import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, readDurable, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { addProject, addRemoteProject, getProject, listProjects, pendingProjectCreates } from '../src/main/projects.js';
import { authorizeBrowserInput, claimBrowserInput, enqueueInput, pendingBrowserInputs, resetInputForTests } from '../src/main/session/input.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import type { ChatgptProjectLink } from '../src/shared/projects.js';
import type { SftpClient } from '../src/main/remote/sftp.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string, folder: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-project-no-native-');
  folder = path.join(directory, 'project');
  await fs.mkdir(folder);
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory); resetInputForTests();
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: directory }] });
});
afterEach(async () => {
  resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

async function expectOpeningOffered(projectId: string) {
  const row = await enqueueInput({ id: randomUUID(), projectId, sessionId: null, text: 'Work in this folder',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  const offered = (await pendingBrowserInputs()).find(entry => entry.id === row.id);
  expect(offered).toMatchObject({ id: row.id, conversationId: null });
  expect(offered).not.toHaveProperty('project');
  expect(await claimBrowserInput(row.id, 'document', null, true)).toMatchObject({ id: row.id });
  expect(await authorizeBrowserInput(row.id, 'document', null)).toBe(true);
}

it('offers a queued new chat in an added project immediately, without a native Project', async () => {
  const project = await addProject(folder);
  await expectOpeningOffered(project.id);
  expect(project).not.toHaveProperty('chatgpt');
  expect(await readDurable('projects')).toEqual([project]);
  expect(await pendingProjectCreates()).toEqual([]);
});

const request = { requestId: '11111111-2222-4333-8444-555555555555', updatedAt: 0 };
const links: ChatgptProjectLink[] = [
  { state: 'requested', ...request },
  { state: 'claimed', ...request, owner: 'old-document' },
  { state: 'creating', ...request, owner: 'old-document' },
  { state: 'failed', ...request, error: 'No native Projects' },
  { state: 'uncertain', ...request, error: 'No receipt' },
  { state: 'linked', id: `g-p-${'a'.repeat(32)}`, updatedAt: 0 }
];
it.each(links)('ignores a saved $state link without rewriting the catalog or holding its new chat', async chatgpt => {
  const project = await addProject(folder, { chatgpt: 'later' });
  const saved = [{ ...project, chatgpt }];
  await writeDurableNow('projects', saved);
  const file = path.join(directory, 'state', 'projects.json');
  const bytes = await fs.readFile(file, 'utf8');
  expect(await listProjects()).toEqual([project]);
  expect(await getProject(project.id)).not.toHaveProperty('chatgpt');
  expect(await pendingProjectCreates()).toEqual([]);
  await expectOpeningOffered(project.id);
  expect(await readDurable('projects')).toEqual(saved);
  expect(await fs.readFile(file, 'utf8')).toBe(bytes);
});

it.each([undefined, 'later'] as const)('adds a server project without a native Project (legacy option: %s)', async chatgpt => {
  const connect = async () => ({ realpath: async () => '/srv/app', stat: async () => ({ isDirectory: true }) }) as unknown as SftpClient;
  const project = await addRemoteProject('devbox', '/srv/app', { connect }, { chatgpt });
  expect(project).not.toHaveProperty('chatgpt');
  expect(await readDurable('projects')).toEqual([project]);
  expect(await pendingProjectCreates()).toEqual([]);
});
