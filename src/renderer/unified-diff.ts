import { Text } from '@codemirror/state';
import { Chunk } from '@codemirror/merge';
import { LanguageDescription, type Language } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { el } from './dom.js';
import { t, tn } from './i18n.js';

export interface DiffLine { kind: 'context' | 'added' | 'removed' | 'gap'; old: number | null; next: number | null; text: string }
export interface Cell { kind: 'context' | 'removed' | 'added'; line: number; text: string }
export interface SplitRow { kind: 'context' | 'change' | 'gap'; left: Cell | null; right: Cell | null; text?: string }
/** Bounded line projection of exact recorded snapshots. Counts remain recorder-owned. */
export function unifiedDiffLines(base: string, current: string, limit = 600): { lines: DiffLine[]; truncated: boolean } {
  const a = Text.of(base.split('\n')), b = Text.of(current.split('\n'));
  const chunks = Chunk.build(a, b, { scanLimit: 1000, timeout: 50 });
  const lines: DiffLine[] = [];
  let old = 1, next = 1, truncated = false;
  const add = (line: DiffLine): void => { if (lines.length < limit) lines.push(line); else truncated = true; };
  const context = (end: number): void => {
    const count = end - old;
    for (let i = 0; i < count; i++) {
      if (count > 6 && i === 3) {
        add({ kind: 'gap', old: null, next: null, text: tn('{0} unchanged line', '{0} unchanged lines', count - 6) });
        old += count - 6; next += count - 6; i += count - 6;
      }
      add({ kind: 'context', old, next, text: a.line(old).text }); old++; next++;
    }
  };
  for (const chunk of chunks) {
    const startA = a.lineAt(Math.min(chunk.fromA, a.length)).number;
    const startB = b.lineAt(Math.min(chunk.fromB, b.length)).number;
    context(startA); next = startB;
    const endA = chunk.toA > chunk.fromA ? a.lineAt(Math.min(chunk.toA - 1, a.length)).number + 1 : startA;
    const endB = chunk.toB > chunk.fromB ? b.lineAt(Math.min(chunk.toB - 1, b.length)).number + 1 : startB;
    for (; old < endA; old++) if (base) add({ kind: 'removed', old, next: null, text: a.line(old).text });
    for (; next < endB; next++) if (current) add({ kind: 'added', old: null, next, text: b.line(next).text });
    if (truncated) break;
  }
  // A file's last real line: the empty one after a final newline is not a line, and an empty
  // (created) file has none at all.
  if (!truncated) context(base === '' ? 1 : a.lines + (base.endsWith('\n') ? 0 : 1));
  return { lines, truncated };
}

/** Pair each replacement run in order, keeping each side's recorded line numbers. */
export function splitDiffRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === 'gap') {
      rows.push({ kind: 'gap', left: null, right: null, text: line.text }); index++;
    } else if (line.kind === 'context') {
      rows.push({ kind: 'context', left: { kind: 'context', line: line.old!, text: line.text },
        right: { kind: 'context', line: line.next!, text: line.text } }); index++;
    } else {
      const removed: DiffLine[] = [], added: DiffLine[] = [];
      while (lines[index]?.kind === 'removed') removed.push(lines[index++]!);
      while (lines[index]?.kind === 'added') added.push(lines[index++]!);
      for (let i = 0; i < Math.max(removed.length, added.length); i++) {
        const left = removed[i], right = added[i];
        rows.push({ kind: 'change', left: left ? { kind: 'removed', line: left.old!, text: left.text } : null,
          right: right ? { kind: 'added', line: right.next!, text: right.text } : null });
      }
    }
  }
  return rows;
}

/** The differing middle, with half-open offsets after stripping a shared prefix and suffix. */
export function changedRange(a: string, b: string): { a: [number, number]; b: [number, number] } {
  let from = 0, endA = a.length, endB = b.length;
  while (from < endA && from < endB && a[from] === b[from]) from++;
  while (endA > from && endB > from && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  // Snap to whole words so `result` → `round(result` reads as a word change, not `esult` → `ound(result`.
  // The prefix and suffix are shared, so both sides move together.
  const word = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}_]/u.test(char);
  const startCut = (at: number): boolean => word(a[at - 1]) && ((at < endA && word(a[at])) || (at < endB && word(b[at])));
  if (endA > from || endB > from) {
    const endCut = word(a[endA]) && ((endA > from && word(a[endA - 1])) || (endB > from && word(b[endB - 1])));
    if (startCut(from)) while (from > 0 && word(a[from - 1])) from--;
    if (endCut) while (endA < a.length && word(a[endA])) { endA++; endB++; }
  }
  return { a: [from, endA], b: [from, endB] };
}

/** Responsive split/unified rows, using text nodes and a small syntax palette. */
export async function renderUnifiedDiff(host: HTMLElement, filename: string, base: string, current: string, currentOwner: () => boolean): Promise<void> {
  const description = LanguageDescription.matchFilename(languages, filename);
  let language: Language | null = null;
  if (description) try { language = (await description.load()).language; } catch { /* Text remains readable. */ }
  if (!host.isConnected || !currentOwner()) return;
  const { lines, truncated } = unifiedDiffLines(base, current);
  const splitRows = splitDiffRows(lines);
  const sign = (kind: string): string => kind === 'added' ? '+' : kind === 'removed' ? '−' : ' ';
  const codeCell = (text: string, syntax: boolean, word?: [number, number]): HTMLElement => {
    const code = el('code', 'diff-code');
    const appendText = (from: number, to: number, classes: string): void => {
      if (from < to) code.append(classes ? el('span', classes, text.slice(from, to)) : text.slice(from, to));
    };
    const append = (from: number, to: number, classes = ''): void => {
      const start = word ? Math.max(from, word[0]) : to, end = word ? Math.min(to, word[1]) : to;
      if (start < end) {
        appendText(from, start, classes);
        appendText(start, end, classes ? `${classes} diff-word` : 'diff-word');
        appendText(end, to, classes);
      } else appendText(from, to, classes);
    };
    if (language && text.length <= 4000 && syntax) {
      let cursor = 0;
      highlightTree(language.parser.parse(text), classHighlighter, (from, to, classes) => {
        append(cursor, from); append(from, to, classes); cursor = to;
      });
      append(cursor, text.length);
    } else append(0, text.length);
    return code;
  };
  const half = (cell: Cell | null, word?: [number, number]): HTMLElement => {
    const node = el('div', `diff-half is-${cell?.kind ?? 'empty'}`); node.setAttribute('role', 'cell');
    node.append(el('span', 'diff-gutter', cell ? String(cell.line) : ''), el('span', 'diff-sign', sign(cell?.kind ?? 'empty')),
      codeCell(cell?.text ?? '', true, word));
    return node;
  };
  let split = host.getBoundingClientRect().width >= 560;
  const render = (): void => {
    const content = el('div', `unified-diff-lines${split ? ' is-split' : ''}`); content.setAttribute('role', 'table');
    if (split) for (const line of splitRows) {
      const row = el('div', `diff-split-row is-${line.kind}`); row.setAttribute('role', 'row');
      if (line.kind === 'gap') {
        const gap = codeCell(line.text ?? '', false); gap.setAttribute('role', 'cell'); gap.setAttribute('aria-colspan', '2');
        row.append(gap);
      } else {
        let word: ReturnType<typeof changedRange> | undefined;
        if (line.kind === 'change' && line.left && line.right && line.left.text.length <= 4000 && line.right.text.length <= 4000) {
          const range = changedRange(line.left.text, line.right.text);
          if (range.a[0] > 0 || range.a[1] < line.left.text.length) word = range;
        }
        row.append(half(line.left, word?.a), half(line.right, word?.b));
      }
      content.append(row);
    } else for (const line of lines) {
      const row = el('div', `diff-line is-${line.kind}`); row.setAttribute('role', 'row');
      row.append(el('span', 'diff-gutter', line.old === null ? '' : String(line.old)),
        el('span', 'diff-gutter', line.next === null ? '' : String(line.next)), el('span', 'diff-sign', sign(line.kind)),
        codeCell(line.text, line.kind !== 'gap'));
      content.append(row);
    }
    host.replaceChildren(content);
    if (truncated) host.append(el('p', 'meta', () => t('Preview limited to 600 lines. Open Review for the complete edit.')));
  };
  render();
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      if (!host.isConnected || !currentOwner()) { observer.disconnect(); return; }
      const nextSplit = host.getBoundingClientRect().width >= 560;
      if (nextSplit === split) return;
      split = nextSplit; render();
    });
    observer.observe(host);
  }
}
