import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = process.cwd();

describe('runtime multi-agent enable regression', () => {
  it('wires persistence before unconditional restore and preserves history while disabled', async () => {
    const source = await readFile(path.join(repo, 'src/main/index.ts'), 'utf8');
    const persistSink = source.indexOf('onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot))');
    const restoreRead = source.indexOf('const savedSwarm = await readDurable<SwarmSnapshot>(SWARM_STATE)');
    const shutdownFence = source.indexOf('if (windowActivation.isDisabled()) return;', restoreRead);
    const restore = source.indexOf('restoreSwarm(savedSwarm)', restoreRead);
    const disabledPause = source.indexOf("pauseSwarmForDisable('multi-agent mode is disabled')");

    expect(persistSink).toBeGreaterThanOrEqual(0);
    expect(restoreRead).toBeGreaterThanOrEqual(0);
    expect(shutdownFence).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(disabledPause).toBeGreaterThanOrEqual(0);
    expect(persistSink).toBeLessThan(restoreRead);
    expect(restoreRead).toBeLessThan(shutdownFence);
    expect(shutdownFence).toBeLessThan(restore);
    expect(restore).toBeLessThan(disabledPause);
    expect(source).not.toContain('await writeDurableNow(SWARM_STATE, null)');
  });
});

describe('companion extension setup contract', () => {
  it('sets up DeepSeek in the app’s own browser instead of an installable extension', async () => {
    const [html, renderer, preload, ipc] = await Promise.all([
      readFile(path.join(repo, 'src/renderer/index.html'), 'utf8'),
      readFile(path.join(repo, 'src/renderer/main.ts'), 'utf8'),
      readFile(path.join(repo, 'src/preload/index.ts'), 'utf8'),
      readFile(path.join(repo, 'src/main/ipc.ts'), 'utf8')
    ]);

    // Setup's browser step is the DeepSeek sign-in, not an extension to side-load.
    expect(html).toContain('id="showCosBrowser"');
    expect(html).toContain('Sign in to DeepSeek');
    expect(html).not.toContain('id="browserExtensionStage"');
    expect(html).not.toContain('id="browserDownload"');
    expect(html).not.toContain('Download extension ZIP');
    expect(renderer).not.toContain('api.downloadExtension()');
    // The IPC stays so an older config or a future provider can still use it, without a page for it.
    expect(preload).toContain("call<boolean>('bridge:downloadExtension')");
    expect(ipc).toContain("handle('bridge:downloadExtension'");
    expect(html).not.toContain('/releases/latest/');
    expect(ipc).not.toContain('/releases/latest/');
  });
});
