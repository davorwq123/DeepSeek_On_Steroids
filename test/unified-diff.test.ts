import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { changedRange, renderUnifiedDiff, splitDiffRows, unifiedDiffLines, type DiffLine } from '../src/renderer/unified-diff.js';

it('aligns old and new gutters through replacement, insertion and deletion', () => {
  const result = unifiedDiffLines('one\ntwo\nthree\n', 'one\nchanged\nnew\nthree\n');
  expect(result.lines.map(({ kind, old, next, text }) => [kind, old, next, text])).toEqual([
    ['context', 1, 1, 'one'], ['removed', 2, null, 'two'], ['added', null, 2, 'changed'], ['added', null, 3, 'new'], ['context', 3, 4, 'three']
  ]);
  expect(result.truncated).toBe(false);
});
it('shows creation and deletion from exact snapshots including a missing final newline', () => {
  expect(unifiedDiffLines('', 'hello').lines.filter(line => line.kind === 'added').map(line => line.text)).toEqual(['hello']);
  expect(unifiedDiffLines('hello', '').lines.filter(line => line.kind === 'removed').map(line => line.text)).toEqual(['hello']);
});
it('shows a created or deleted file as its lines only, with no empty row for the missing other side', () => {
  const rows = (base: string, current: string) => unifiedDiffLines(base, current).lines.map(({ kind, old, next, text }) => [kind, old, next, text]);
  expect(rows('', 'release round ok\n')).toEqual([['added', null, 1, 'release round ok']]);
  expect(rows('', 'one\ntwo')).toEqual([['added', null, 1, 'one'], ['added', null, 2, 'two']]);
  expect(rows('one\ntwo\n', '')).toEqual([['removed', 1, null, 'one'], ['removed', 2, null, 'two']]);
  // An edit still ends at the file's last real line.
  expect(rows('one\n', 'one\ntwo\n')).toEqual([['context', 1, 1, 'one'], ['added', null, 2, 'two']]);
});
it('bounds rendered lines and folds long unchanged context without changing line identities', () => {
  const source = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const result = unifiedDiffLines(source, source.replace('line 50', 'edited 50'));
  expect(result.lines.some(line => line.kind === 'gap')).toBe(true);
  expect(result.lines.find(line => line.kind === 'added')?.next).toBe(51);
  expect(unifiedDiffLines('', 'line\n'.repeat(5000)).lines).toHaveLength(600);
  expect(unifiedDiffLines('', 'line\n'.repeat(5000)).truncated).toBe(true);
});

it('pairs unequal replacement runs with fillers and preserves each side’s line numbers', () => {
  const lines: DiffLine[] = [
    { kind: 'removed', old: 2, next: null, text: 'old two' },
    { kind: 'removed', old: 3, next: null, text: 'old three' },
    { kind: 'added', old: null, next: 2, text: 'new two' },
    { kind: 'context', old: 4, next: 3, text: 'same' },
    { kind: 'removed', old: 5, next: null, text: 'old five' },
    { kind: 'added', old: null, next: 4, text: 'new four' },
    { kind: 'added', old: null, next: 5, text: 'new five' }
  ];
  const original = structuredClone(lines);
  expect(splitDiffRows(lines)).toEqual([
    { kind: 'change', left: { kind: 'removed', line: 2, text: 'old two' }, right: { kind: 'added', line: 2, text: 'new two' } },
    { kind: 'change', left: { kind: 'removed', line: 3, text: 'old three' }, right: null },
    { kind: 'context', left: { kind: 'context', line: 4, text: 'same' }, right: { kind: 'context', line: 3, text: 'same' } },
    { kind: 'change', left: { kind: 'removed', line: 5, text: 'old five' }, right: { kind: 'added', line: 4, text: 'new four' } },
    { kind: 'change', left: null, right: { kind: 'added', line: 5, text: 'new five' } }
  ]);
  expect(lines).toEqual(original);
});

it('pairs pure insertion and deletion runs with empty cells', () => {
  expect(splitDiffRows(unifiedDiffLines('', 'one\ntwo').lines)).toEqual([
    { kind: 'change', left: null, right: { kind: 'added', line: 1, text: 'one' } },
    { kind: 'change', left: null, right: { kind: 'added', line: 2, text: 'two' } }
  ]);
  expect(splitDiffRows(unifiedDiffLines('one\ntwo', '').lines)).toEqual([
    { kind: 'change', left: { kind: 'removed', line: 1, text: 'one' }, right: null },
    { kind: 'change', left: { kind: 'removed', line: 2, text: 'two' }, right: null }
  ]);
});

it('passes context and gaps through without pairing changes across them', () => {
  expect(splitDiffRows([
    { kind: 'context', old: 10, next: 12, text: 'same' },
    { kind: 'removed', old: 11, next: null, text: 'old' },
    { kind: 'gap', old: null, next: null, text: '20 unchanged lines' },
    { kind: 'added', old: null, next: 33, text: 'new' }
  ])).toEqual([
    { kind: 'context', left: { kind: 'context', line: 10, text: 'same' }, right: { kind: 'context', line: 12, text: 'same' } },
    { kind: 'change', left: { kind: 'removed', line: 11, text: 'old' }, right: null },
    { kind: 'gap', left: null, right: null, text: '20 unchanged lines' },
    { kind: 'change', left: null, right: { kind: 'added', line: 33, text: 'new' } }
  ]);
  expect(splitDiffRows([])).toEqual([]);
});

it.each([
  { a: 'same old', b: 'same new', expected: { a: [5, 8], b: [5, 8] } },
  { a: 'old tail', b: 'new tail', expected: { a: [0, 3], b: [0, 3] } },
  { a: 'one red end', b: 'one blue end', expected: { a: [4, 7], b: [4, 8] } },
  { a: 'the cat', b: 'the black cat', expected: { a: [4, 4], b: [4, 10] } },
  { a: 'aaa', b: 'aa', expected: { a: [0, 3], b: [0, 2] } },
  { a: 'return result', b: 'return round(result * 2)', expected: { a: [7, 13], b: [7, 24] } },
  { a: 'x = fooBar;', b: 'x = bazBar;', expected: { a: [4, 10], b: [4, 10] } },
  { a: 'same', b: 'same', expected: { a: [4, 4], b: [4, 4] } },
  { a: '', b: '', expected: { a: [0, 0], b: [0, 0] } },
  { a: '', b: 'new', expected: { a: [0, 0], b: [0, 3] } },
  { a: 'old', b: 'newer', expected: { a: [0, 3], b: [0, 5] } }
])('finds the differing middle of "$a" and "$b"', ({ a, b, expected }) => {
  expect(changedRange(a, b)).toEqual(expected);
});

let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });

function mount(width: number): { host: HTMLElement; setWidth: (width: number) => void } {
  dom = new JSDOM('<div class="unified-diff"></div>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('ResizeObserver', undefined);
  const host = document.querySelector<HTMLElement>('.unified-diff')!;
  let measuredWidth = width;
  vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => ({ width: measuredWidth } as DOMRect));
  return { host, setWidth: value => { measuredWidth = value; } };
}

function stubResizeObserver(): { fire: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } {
  let fire!: () => void;
  const observe = vi.fn(), disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { fire = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  return { fire: () => fire(), observe, disconnect };
}

const before = '// before\nconst color = "<script>red</script>";\n// after\n';
const after = before.replace('red', 'blue');

it('renders old text on the left and new text on the right at 560px, combining word and syntax spans safely', async () => {
  const { host } = mount(560);
  await renderUnifiedDiff(host, 'app.ts', before, after, () => true);
  expect(host.querySelector('.unified-diff-lines.is-split')?.getAttribute('role')).toBe('table');
  expect(host.querySelectorAll('.diff-split-row')).toHaveLength(3);
  const row = host.querySelector('.diff-split-row.is-change')!;
  expect(row.getAttribute('role')).toBe('row');
  const [left, right] = Array.from(row.children);
  expect(left?.className).toBe('diff-half is-removed');
  expect(right?.className).toBe('diff-half is-added');
  expect(left?.querySelector('.diff-gutter')?.textContent).toBe('2');
  expect(right?.querySelector('.diff-gutter')?.textContent).toBe('2');
  expect(left?.querySelector('.diff-sign')?.textContent).toBe('−');
  expect(right?.querySelector('.diff-sign')?.textContent).toBe('+');
  expect(left?.querySelector('.diff-code')?.textContent).toBe('const color = "<script>red</script>";');
  expect(right?.querySelector('.diff-code')?.textContent).toBe('const color = "<script>blue</script>";');
  expect(left?.querySelector('.diff-word.tok-string')?.textContent).toBe('red');
  expect(right?.querySelector('.diff-word.tok-string')?.textContent).toBe('blue');
  expect(left?.querySelector('.tok-keyword')?.textContent).toBe('const');
  expect(host.querySelector('script')).toBeNull();
  expect(host.querySelector('.diff-line')).toBeNull();
});

it('keeps classic unified rows and both gutters below 560px without ResizeObserver', async () => {
  const { host } = mount(559);
  await renderUnifiedDiff(host, 'app.ts', before, after, () => true);
  expect(host.querySelector('.is-split')).toBeNull();
  expect(host.querySelectorAll('.diff-line')).toHaveLength(4);
  const removed = host.querySelector('.diff-line.is-removed')!;
  const added = host.querySelector('.diff-line.is-added')!;
  expect(Array.from(removed.querySelectorAll('.diff-gutter'), node => node.textContent)).toEqual(['2', '']);
  expect(Array.from(added.querySelectorAll('.diff-gutter'), node => node.textContent)).toEqual(['', '2']);
  expect(removed.querySelector('.diff-code')?.textContent).toContain('red');
  expect(added.querySelector('.diff-code')?.textContent).toContain('blue');
  expect(host.querySelector('.diff-word')).toBeNull();
});

it('renders a full-width gap and visible empty halves for unpaired split rows', async () => {
  const { host } = mount(800);
  const context = 'unchanged\n'.repeat(20);
  await renderUnifiedDiff(host, 'app.txt', context, `${context}inserted\n`, () => true);
  const gap = host.querySelector('.diff-split-row.is-gap')!;
  expect(gap.children).toHaveLength(1);
  expect(gap.firstElementChild?.getAttribute('aria-colspan')).toBe('2');
  expect(gap.textContent).toContain('unchanged lines');
  const row = host.querySelector('.diff-split-row.is-change')!;
  expect(row.firstElementChild?.className).toBe('diff-half is-empty');
  expect(row.firstElementChild?.querySelector('.diff-code')?.textContent).toBe('');
  expect(row.lastElementChild?.querySelector('.diff-code')?.textContent).toBe('inserted');
});

it.each([
  ['old', 'new'],
  [`same ${'x'.repeat(4001)} red`, 'same blue'],
  ['same red', `same ${'x'.repeat(4001)} blue`]
])('skips word emphasis on wholly different or oversized lines (case %#)', async (base, current) => {
  const { host } = mount(800);
  await renderUnifiedDiff(host, 'app.txt', base, current, () => true);
  expect(host.querySelector('.diff-half.is-removed .diff-code')?.textContent).toBe(base);
  expect(host.querySelector('.diff-half.is-added .diff-code')?.textContent).toBe(current);
  expect(host.querySelector('.diff-word')).toBeNull();
});

it('still emphasizes changes when both lines are exactly 4000 characters', async () => {
  const { host } = mount(800);
  const prefix = `${'x'.repeat(3996)} `;
  await renderUnifiedDiff(host, 'app.txt', `${prefix}red`, `${prefix}sky`, () => true);
  expect(host.querySelector('.is-removed .diff-word')?.textContent).toBe('red');
  expect(host.querySelector('.is-added .diff-word')?.textContent).toBe('sky');
});

it('emphasizes just the inserted middle when the paired old line has an empty range', async () => {
  const { host } = mount(800);
  await renderUnifiedDiff(host, 'app.txt', 'the cat', 'the black cat', () => true);
  expect(host.querySelector('.is-removed .diff-word')).toBeNull();
  expect(host.querySelector('.is-added .diff-word')?.textContent).toBe('black ');
});

it.each([559, 800])('keeps the 600-line truncation note at %ipx', async width => {
  const { host } = mount(width);
  await renderUnifiedDiff(host, 'app.txt', '', 'line\n'.repeat(610), () => true);
  expect(host.querySelectorAll('[role="row"]')).toHaveLength(600);
  expect(host.querySelector('.meta')?.textContent).toBe('Preview limited to 600 lines. Open Review for the complete edit.');
});

it('only replaces rows when a resize crosses the layout threshold in either direction', async () => {
  const { host, setWidth } = mount(600);
  const observer = stubResizeObserver();
  await renderUnifiedDiff(host, 'app.txt', 'same old', 'same new', () => true);
  expect(observer.observe).toHaveBeenCalledExactlyOnceWith(host);
  const split = host.firstElementChild;
  setWidth(800); observer.fire();
  expect(host.firstElementChild).toBe(split);
  setWidth(559); observer.fire();
  expect(host.querySelector('.is-split')).toBeNull();
  expect(host.querySelectorAll('.diff-line')).toHaveLength(2);
  const unified = host.firstElementChild;
  setWidth(400); observer.fire();
  expect(host.firstElementChild).toBe(unified);
  setWidth(560); observer.fire();
  expect(host.querySelector('.is-split')).not.toBeNull();
  expect(host.querySelectorAll('.diff-split-row')).toHaveLength(1);
  expect(observer.disconnect).not.toHaveBeenCalled();
});

it.each(['ownership', 'removal'])('disconnects without rendering when %s retires a resize owner', async retirement => {
  const { host, setWidth } = mount(800);
  const observer = stubResizeObserver();
  let current = true;
  await renderUnifiedDiff(host, 'app.txt', 'old', 'new', () => current);
  const content = host.firstElementChild;
  if (retirement === 'ownership') current = false; else host.remove();
  setWidth(400); observer.fire();
  expect(observer.disconnect).toHaveBeenCalledOnce();
  expect(host.firstElementChild).toBe(content);
});

it.each(['ownership', 'removal'])('does not render or observe after %s retires a pending syntax load', async retirement => {
  const { host } = mount(800);
  const observer = stubResizeObserver();
  let current = true;
  const pending = renderUnifiedDiff(host, 'app.ts', before, after, () => current);
  if (retirement === 'ownership') current = false; else host.remove();
  await pending;
  expect(host.children).toHaveLength(0);
  expect(observer.observe).not.toHaveBeenCalled();
});
