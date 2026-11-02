import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseTargets } from './release-targets.mjs';

/** One asset list for assembly, publishing and verification; DeepSeek needs no standalone add-on. */
export const RELEASE_FILES = releaseTargets('all').files;
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyReleaseAssets({ dir, tag, commit }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) return ['A stable version tag is required.'];
  const sumsFile = path.join(dir, 'SHA256SUMS.txt');
  if (!existsSync(sumsFile)) return ['SHA256SUMS.txt is missing from the release.'];
  const sums = new Map();
  const problems = [];
  for (const line of readFileSync(sumsFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-f0-9]{64}) [ *]([^/\\]+)$/i.exec(line);
    if (!match || sums.has(match[2])) { problems.push('SHA256SUMS.txt contains an invalid or duplicate entry.'); continue; }
    sums.set(match[2], match[1].toLowerCase());
  }
  for (const name of RELEASE_FILES) {
    const file = path.join(dir, name);
    if (!existsSync(file)) { problems.push(`${name} is missing from the release.`); continue; }
    if (!sums.has(name)) { problems.push(`${name} is not listed in SHA256SUMS.txt.`); continue; }
    if (await sha256(file) !== sums.get(name)) problems.push(`${name} does not match its SHA256SUMS.txt checksum.`);
  }
  const provenance = path.join(dir, 'release-manifest.json');
  if (existsSync(provenance)) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(provenance, 'utf8')); } catch { /* rejected below */ }
    if (!manifest || manifest.version !== tag.slice(1) || !/^[a-f0-9]{40}$/.test(manifest.commit ?? '') ||
        (commit && manifest.commit !== commit) || JSON.stringify(manifest.files) !== JSON.stringify(RELEASE_FILES)) {
      problems.push('release-manifest.json does not match the tag, source commit or expected native assets.');
    }
  }
  return problems;
}

async function main() {
  const [dir, tag, report, commit] = process.argv.slice(2);
  if (!dir || !tag) throw new Error('Usage: node scripts/verify-release-assets.mjs <folder> <tag> [report.md] [commit]');
  const problems = await verifyReleaseAssets({ dir, tag, commit });
  if (report) writeFileSync(report, problems.map(problem => `- ${problem}`).join('\n') + '\n');
  if (problems.length) { for (const problem of problems) console.error(problem); process.exitCode = 1; }
  else console.log(`${tag}: all ${RELEASE_FILES.length} assets match their checksums and candidate provenance.`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
