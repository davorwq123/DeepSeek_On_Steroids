import { expect, it } from 'vitest';
import { githubRepository } from '../src/shared/release.js';
it('accepts a canonical GitHub project and rejects missing or ambiguous release ownership', () => {
  expect(githubRepository('https://github.com/release-owner/deepseek-on-steroids')).toBe('release-owner/deepseek-on-steroids');
  expect(githubRepository('https://github.com/release-owner/deepseek-on-steroids/')).toBe('release-owner/deepseek-on-steroids');
  for (const value of [null, undefined, '', 'https://github.com/', 'https://github.com/owner',
    'https://evil.example/owner/repo', 'http://github.com/owner/repo', 'https://github.com/owner/repo/issues',
    'https://user:secret@github.com/owner/repo', 'https://github.com/owner/repo?other=1', 'https://github.com/owner/repo#other']) {
    expect(githubRepository(value), String(value)).toBeNull();
  }
});
