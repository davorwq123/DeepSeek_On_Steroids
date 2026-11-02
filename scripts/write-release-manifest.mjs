import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { releaseTargets } from './release-targets.mjs';

/** Derived provenance for the same candidate run that built and checked the native packages. */
export function releaseManifest(version, commit, platforms = 'all') {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable package version is required');
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('The exact source commit is required');
  return { version, commit, files: releaseTargets(platforms).files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = releaseManifest(version, process.env.GITHUB_SHA, process.argv[2] ?? 'all');
  const directory = new URL('../release/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(new URL('release-manifest.json', directory), JSON.stringify(manifest, null, 2) + '\n');
}
