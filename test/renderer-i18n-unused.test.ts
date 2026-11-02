import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('prunes all catalogs together while retaining every source form, IPC text and uncertain template', async () => {
  const script = '../scripts/locale-unused.mjs';
  const { inspectLocales, writeLocales } = await import(script);
  const root = await mkdtemp(path.join(os.tmpdir(), 'locale-unused-'));
  const locales = ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
  const kept = ["Don't remove", '1 item', '{0} items', 'A bound label', 'A text node',
    'HTML & text', 'Multi line label', 'An attribute', 'A main-process failure.',
    'A shared native-dialog title', 'Extension text', 'Script text', 'Folder {0} is unavailable', 'read {0}', 'Could not read {0}'];
  const unused = ['Obsolete label', 'Obsolete {0} count', 'Generated keys are not evidence'];
  try {
    for (const directory of ['src/renderer/locales', 'src/main', 'src/shared', 'extension', 'scripts']) {
      await mkdir(path.join(root, directory), { recursive: true });
    }
    for (const locale of locales) {
      const catalog: Record<string, string> = Object.fromEntries([...kept, ...unused].map(key => [key, key]));
      for (const form of new Intl.PluralRules(locale).resolvedOptions().pluralCategories.filter(form => form !== 'other')) {
        catalog[`{0} items|${form}`] = '{0} items';
        catalog[`Obsolete {0} count|${form}`] = 'Obsolete {0} count';
      }
      await writeFile(path.join(root, 'src/renderer/locales', `${locale}.json`), JSON.stringify(catalog));
    }
    await writeFile(path.join(root, 'src/renderer/i18n-source-keys.json'), JSON.stringify(unused));
    await writeFile(path.join(root, 'src/renderer/screen.ts'), String.raw`
      t('Don\'t remove'); tn('1 item', '{0} items', count);
      ui(node, 'textContent', () => t('A bound label')); uiText(() => t('A text node'));
    `);
    await writeFile(path.join(root, 'src/renderer/index.html'), '<body><p>HTML &amp; text</p><p>Multi\n  line label</p><input title="An attribute"></body>');
    await writeFile(path.join(root, 'src/main/input.ts'), 'throw new Error("A main-process failure."); const error = `Folder ${folder} is unavailable`; const phrase = "read {0}"; const title = `Could not ${phrase}`;');
    await writeFile(path.join(root, 'src/shared/main-texts.ts'), 'const texts = ["A shared native-dialog title"];');
    await writeFile(path.join(root, 'extension/content.js'), 'const label = "Extension text";');
    await writeFile(path.join(root, 'scripts/fixture.mjs'), 'const label = "Script text";');
    const result = await inspectLocales(root);
    expect(result.unused).toEqual(unused);
    expect(result.uncertain.map((entry: { key: string }) => entry.key)).toEqual(['Folder {0} is unavailable', 'Could not read {0}']);
    expect(result.sourceKeys).toEqual(['An attribute', 'HTML & text', 'Multi line label']);
    await writeLocales(result, root);
    for (const locale of locales) {
      const catalog = JSON.parse(await readFile(path.join(root, 'src/renderer/locales', `${locale}.json`), 'utf8'));
      expect(Object.keys(catalog).filter(key => !key.includes('|')).sort()).toEqual([...kept].sort());
      expect(Object.keys(catalog).filter(key => key.includes('|')).sort()).toEqual(
        new Intl.PluralRules(locale).resolvedOptions().pluralCategories.filter(form => form !== 'other').map(form => `{0} items|${form}`).sort());
    }
    expect(JSON.parse(await readFile(path.join(root, 'src/renderer/i18n-source-keys.json'), 'utf8'))).toEqual(result.sourceKeys);
    expect((await inspectLocales(root)).unused).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
