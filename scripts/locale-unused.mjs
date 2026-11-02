#!/usr/bin/env node
/**
 * Conservatively prune renderer catalogs: node scripts/locale-unused.mjs [--write].
 * Search ALL source text, not just t() calls: IPC producers, ui()/uiText(), HTML,
 * extension copy and scripts count too. Decode literals/entities and normalize HTML
 * whitespace just as i18n.ts does. Numbered placeholders also match JS templates
 * and concatenations. Bundled pet metadata is also rendered through t(). Keep
 * every language's existing plural forms with its base.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localeDirectory = 'src/renderer/locales';
const sourceKeyFile = 'src/renderer/i18n-source-keys.json';
const pluralForm = /\|(zero|one|two|few|many)$/;
const normalize = text => text.replace(/\s+/g, ' ').trim();

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(file));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort();
}

/** Static shell bindings use the exact same exclusions and attributes as initLanguage. */
function htmlKeys(html, inline = false) {
  // Inline fragments share jsdom's inert parsing document; do not allocate a full
  // Window for each of the thousands of HTML literals in code and fixtures.
  const dom = inline ? null : new JSDOM(html);
  const root = inline ? JSDOM.fragment(html) : dom.window.document.body;
  const document = root.ownerDocument;
  const keys = new Set();
  const walker = document.createTreeWalker(root, 4);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) {
      keys.add(normalize(node.textContent));
    }
  }
  for (const node of (dom?.window.document ?? root).querySelectorAll('[title], [placeholder], [aria-label]')) {
    if (node.closest('[translate="no"]')) continue;
    for (const property of ['title', 'placeholder', 'aria-label']) {
      const value = node.getAttribute(property);
      if (value) keys.add(value);
    }
  }
  dom?.window.close();
  return keys;
}

/** Literal decoding never executes project code. Unknown expressions stay holes. */
function sourceStrings(file, source) {
  const strings = [];
  const templates = [];
  if (file.endsWith('.json')) {
    function visitJson(value) {
      if (typeof value === 'string') strings.push(value);
      else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) { strings.push(key); visitJson(child); }
      }
    }
    visitJson(JSON.parse(source));
    return { strings, templates };
  }
  const parsed = parse(source, { sourceType: 'unambiguous', plugins: ['typescript'],
    allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  function parts(node) {
    if (node.type === 'StringLiteral') return [node.value];
    if (node.type === 'TemplateLiteral') {
      return node.quasis.flatMap((quasi, index) => index ? [null, quasi.value.cooked ?? quasi.value.raw] : [quasi.value.cooked ?? quasi.value.raw]);
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      return [...parts(node.left), ...parts(node.right)];
    }
    return [null];
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'StringLiteral') strings.push(node.value);
    if (node.type === 'TemplateElement') strings.push(node.value.cooked ?? node.value.raw);
    if (node.type === 'TemplateLiteral' || node.type === 'BinaryExpression' && node.operator === '+') {
      const fragments = parts(node);
      if (fragments.some(part => part !== null && part.length)) templates.push(fragments);
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parsed);
  return { strings, templates };
}

export async function inspectLocales(base = root) {
  const names = (await readdir(path.join(base, localeDirectory))).filter(name => name.endsWith('.json')).sort();
  const catalogs = await Promise.all(names.map(async name => ({
    name, catalog: JSON.parse(await readFile(path.join(base, localeDirectory, name), 'utf8'))
  })));
  if (!catalogs.length) throw new Error('No locale catalogs found');
  const keys = Object.keys(catalogs[0].catalog).filter(key => !pluralForm.test(key));
  const expected = JSON.stringify([...keys].sort());
  for (const { name, catalog } of catalogs) {
    if (JSON.stringify(Object.keys(catalog).filter(key => !pluralForm.test(key)).sort()) !== expected) {
      throw new Error(`Base key sets differ: ${name}; refusing to remove anything`);
    }
  }
  const sources = [];
  const templates = [];
  const shellKeys = new Set();
  const directories = ['src', 'extension', 'scripts'];
  // These descriptions come from package metadata, through the main-process pet library.
  try { await readdir(path.join(base, 'pets')); directories.push('pets'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const directory of directories) {
    for (const absolute of await filesIn(path.join(base, directory))) {
      const file = path.relative(base, absolute).split(path.sep).join('/');
      // Generated keys must not count as their own usage evidence.
      if (file.startsWith(`${localeDirectory}/`) || file === sourceKeyFile) continue;
      const buffer = await readFile(absolute);
      if (buffer.includes(0)) continue; // Binary assets are not source text.
      const source = buffer.toString('utf8');
      sources.push(source, normalize(source));
      if (/\.(?:[cm]?js|tsx?|json)$/.test(file)) {
        const decoded = sourceStrings(file, source);
        sources.push(...decoded.strings, ...decoded.strings.map(normalize));
        templates.push(...decoded.templates.map(parts => ({ file, parts })));
        // HTML assembled inside a JS literal has entities too (innerHTML fixtures).
        for (const literal of decoded.strings) {
          if (/<[a-z][\s\S]*>/i.test(literal)) sources.push(...htmlKeys(literal, true));
        }
      }
      if (file.endsWith('.html')) {
        const found = htmlKeys(source);
        sources.push(...found);
        if (file.startsWith('src/renderer/')) for (const key of found) shellKeys.add(key);
      }
    }
  }
  const corpus = sources.join('\u0000');
  const patterns = templates.filter(({ parts }) => parts.some(part => part && /[a-zA-Z]/.test(part)))
    .map(({ file, parts }) => {
      const segments = [''];
      for (const part of parts) {
        if (part === null) segments.push('');
        else segments[segments.length - 1] += part;
      }
      for (let index = 0; index < segments.length; index++) segments[index] = segments[index].replace(/\s+/g, ' ');
      segments[0] = segments[0].trimStart();
      segments[segments.length - 1] = segments[segments.length - 1].trimEnd();
      return { file, segments };
    });
  function matchesTemplate(key, segments) {
    if (segments.length === 1) return key === segments[0];
    const first = segments[0], last = segments[segments.length - 1];
    if (!key.startsWith(first) || !key.endsWith(last)) return false;
    let cursor = first.length;
    const end = key.length - last.length;
    // Ordered literal fragments, with unknown holes. Avoid an exponential .* regex
    // for source templates containing many interpolations.
    for (const segment of segments.slice(1, -1)) {
      const at = key.indexOf(segment, cursor);
      if (at < 0) return false;
      cursor = at + segment.length;
    }
    return cursor <= end;
  }
  const uncertain = [];
  const unused = [];
  for (const key of keys) {
    if (corpus.includes(key)) continue;
    // A runtime interpolation can have the same shape but its argument numbering
    // need not match. Preserve it, and report that conservative choice for review.
    // This also protects derived keys such as `Could not ${infinitive}`, where
    // infinitive itself is an English phrase containing a numbered placeholder.
    const match = patterns.find(({ segments }) => matchesTemplate(normalize(key), segments));
    if (match) uncertain.push({ key, file: match.file, reason: 'runtime template/concatenation' });
    else unused.push(key);
  }
  const removed = new Set(unused);
  return { catalogs, unused, uncertain,
    sourceKeys: keys.filter(key => !removed.has(key) && shellKeys.has(key)).sort() };
}

export async function writeLocales(result, base = root) {
  async function writeIfChanged(file, value) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    try { if (await readFile(file, 'utf8') === text) return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(file, text);
  }
  const removed = new Set(result.unused);
  for (const { name, catalog } of result.catalogs) {
    const entries = Object.fromEntries(Object.entries(catalog).filter(([key]) => !removed.has(key.replace(pluralForm, ''))));
    await writeIfChanged(path.join(base, localeDirectory, name), entries);
  }
  await writeIfChanged(path.join(base, sourceKeyFile), result.sourceKeys);
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--write')) throw new Error('Usage: node scripts/locale-unused.mjs [--write]');
  const result = await inspectLocales();
  for (const key of result.unused) console.log(`unused ${JSON.stringify(key)}`);
  for (const kept of result.uncertain) console.log(`kept (uncertain: ${kept.reason}, ${kept.file}) ${JSON.stringify(kept.key)}`);
  if (process.argv.includes('--write')) await writeLocales(result);
  console.log(`${process.argv.includes('--write') ? 'Removed' : 'Found'} ${result.unused.length} unused base keys in each of ${result.catalogs.length} catalogs; ${result.uncertain.length} uncertain keys kept; ${result.sourceKeys.length} static shell keys.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
