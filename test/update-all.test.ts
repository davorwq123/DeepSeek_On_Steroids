import { beforeEach, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../src/shared/types.js';
import { APP_VERSION } from '../src/main/version.js';
import { faultGate } from './helpers.js';

const owners = vi.hoisted(() => ({ check: vi.fn(), status: vi.fn(), mark: vi.fn(), bridge: vi.fn(), connect: vi.fn(), refresh: vi.fn() }));
vi.mock('../src/main/update.js', () => ({ checkForUpdates: owners.check, updateStatus: owners.status,
  markInstallOnQuit: owners.mark, manualDownloadUrl: (v: string) => `https://example.test/${v}` }));
vi.mock('../src/main/bridge.js', () => ({ startBridge: owners.bridge }));
vi.mock('../src/main/connection.js', () => ({ connect: owners.connect }));
vi.mock('../src/main/plugin-refresh.js', () => ({ requestPluginRefreshes: owners.refresh }));
import { updateAll } from '../src/main/update-all.js';
let status: UpdateStatus;
const quit = vi.fn(), manual = vi.fn(), approve = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  status = { current: APP_VERSION, latest: null, stage: 'idle', checkedAt: 1, error: null };
  owners.status.mockImplementation(() => ({ ...status }));
  owners.check.mockResolvedValue(undefined); owners.mark.mockReturnValue(true);
  approve.mockResolvedValue(true); manual.mockResolvedValue(undefined);
});
it.each([false, true])('checks an edition without starting any tunnel or plugin refresh (unavailable=%s)', async unavailable => {
  status.unavailable = unavailable;
  expect(await updateAll(quit, manual, approve)).toBe('checked');
  for (const fn of [owners.bridge, owners.connect, owners.refresh, quit, manual, approve]) expect(fn).not.toHaveBeenCalled();
});
it('coalesces clicks and waits for approval of the downloaded version before quitting', async () => {
  status.latest = '99.0.0'; status.stage = 'ready';
  const gate = faultGate(); approve.mockImplementationOnce(async () => { await gate.hold(); return false; });
  const first = updateAll(quit, manual, approve); await gate.entered;
  expect(updateAll(quit, manual, approve)).toBe(first);
  expect(owners.mark).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
  gate.release(); expect(await first).toBe('confirm');
  expect(await updateAll(quit, manual, approve)).toBe('restarting');
  expect(approve).toHaveBeenLastCalledWith('99.0.0');
  expect(owners.mark).toHaveBeenCalledWith('99.0.0'); expect(quit).toHaveBeenCalledTimes(1);
  expect(owners.connect).not.toHaveBeenCalled(); expect(owners.refresh).not.toHaveBeenCalled();
});
it('opens manual downloads without claiming installation and allows retry after an open failure', async () => {
  status.latest = '99.0.0'; manual.mockRejectedValueOnce(new Error('Browser unavailable'));
  await expect(updateAll(quit, manual, approve)).rejects.toThrow('Browser unavailable');
  await expect(updateAll(quit, manual, approve)).resolves.toBe('manual');
  expect(manual).toHaveBeenLastCalledWith('https://example.test/99.0.0');
  expect(quit).not.toHaveBeenCalled(); expect(owners.mark).not.toHaveBeenCalled();
});
it('retains an update failure without starting a tunnel or opening an old download', async () => {
  status.stage = 'failed'; status.error = 'Network unavailable'; status.latest = '99.0.0';
  await expect(updateAll(quit, manual, approve)).rejects.toThrow('Network unavailable');
  expect(owners.connect).not.toHaveBeenCalled(); expect(manual).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
});
it('does not quit if the approved staged installer is no longer available', async () => {
  status.latest = '99.0.0'; status.stage = 'ready'; owners.mark.mockReturnValue(false);
  await expect(updateAll(quit, manual, approve)).rejects.toThrow(/downloaded update/);
  expect(quit).not.toHaveBeenCalled();
});
