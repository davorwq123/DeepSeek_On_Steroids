/** One explicit app update. DeepSeek's browser and local tool host require no MCP connection. */
import { checkForUpdates, manualDownloadUrl, markInstallOnQuit, updateStatus } from './update.js';
import type { UpdateAllResult } from '../shared/types.js';

let pass: Promise<UpdateAllResult> | null = null;
export function updateAll(quit: () => void, openDownload: (url: string) => Promise<void>, confirmRestart: (version: string) => Promise<boolean>): Promise<UpdateAllResult> {
  if (pass) return pass;
  const run = (async (): Promise<UpdateAllResult> => {
    await checkForUpdates();
    const update = updateStatus();
    if (update.stage === 'failed') throw new Error(update.error ?? 'Update check failed');
    if (update.unavailable || !update.latest) return 'checked';
    if (update.stage === 'ready') {
      if (!await confirmRestart(update.latest)) return 'confirm';
      if (!markInstallOnQuit(update.latest)) throw new Error('There is no downloaded update to install yet');
      quit();
      return 'restarting';
    }
    await openDownload(manualDownloadUrl(update.latest));
    return 'manual';
  })().finally(() => { if (pass === run) pass = null; });
  pass = run;
  return run;
}
