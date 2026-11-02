import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Build scripts are plain ESM.
import { RELEASE_FILES, verifyReleaseAssets } from '../scripts/verify-release-assets.mjs';
// @ts-expect-error Build scripts are plain ESM.
import { releaseManifest } from '../scripts/write-release-manifest.mjs';
let dir = '';
const commit = 'a'.repeat(40);
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function release(version = '2.1.48') {
  dir = mkdtempSync(path.join(tmpdir(), 'deepseek-release-'));
  const sums = [];
  for (const name of RELEASE_FILES as string[]) {
    const bytes = name === 'release-manifest.json' ? JSON.stringify(releaseManifest(version, commit)) : `contents of ${name}`;
    writeFileSync(path.join(dir, name), bytes);
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  writeFileSync(path.join(dir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  return dir;
}
it('accepts native app assets and source provenance without a ChatGPT extension or Mozilla credentials', async () => {
  expect((RELEASE_FILES as string[]).some(file => /Extension|Firefox|\.xpi$/.test(file))).toBe(false);
  expect(await verifyReleaseAssets({ dir: release(), tag: 'v2.1.48', commit })).toEqual([]);
});
it('refuses changed installer bytes and missing corresponding native sources', async () => {
  release(); writeFileSync(path.join(dir, 'DeepSeek-On-Steroids-Setup-x64.exe'), 'changed');
  rmSync(path.join(dir, 'DeepSeek-On-Steroids-Native-Sources.tar.gz'));
  expect(await verifyReleaseAssets({ dir, tag: 'v2.1.48' })).toEqual([
    'DeepSeek-On-Steroids-Setup-x64.exe does not match its SHA256SUMS.txt checksum.',
    'DeepSeek-On-Steroids-Native-Sources.tar.gz is missing from the release.'
  ]);
});
it('refuses candidate provenance from another tag or another source commit', async () => {
  expect(await verifyReleaseAssets({ dir: release('2.1.47'), tag: 'v2.1.48' })).toContain(
    'release-manifest.json does not match the tag, source commit or expected native assets.');
  expect(await verifyReleaseAssets({ dir, tag: 'v2.1.47', commit: 'b'.repeat(40) })).toHaveLength(1);
});
it('refuses files without checksums and malformed candidate identities', async () => {
  release(); rmSync(path.join(dir, 'SHA256SUMS.txt'));
  expect(await verifyReleaseAssets({ dir, tag: 'v2.1.48' })).toEqual(['SHA256SUMS.txt is missing from the release.']);
  expect(() => releaseManifest('2.1.48', '')).toThrow('source commit');
  expect(await verifyReleaseAssets({ dir, tag: 'canary' })).toEqual(['A stable version tag is required.']);
});
