import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let repository;
try {
  const url = new URL(pkg.homepage);
  if (url.origin === 'https://github.com' && !url.search && !url.hash && !url.username && !url.password &&
      /^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) repository = url.pathname.slice(1).replace(/\/$/, '');
} catch { /* Fail before any publish or release download. */ }
if (!repository) throw new Error('Set package.json homepage to this DeepSeek fork’s GitHub repository before packaging a release.');
if (process.env.GITHUB_REPOSITORY && repository.toLowerCase() !== process.env.GITHUB_REPOSITORY.toLowerCase()) {
  throw new Error('The configured release repository does not match this workflow repository.');
}
console.log(`Release repository verified: ${repository}`);
