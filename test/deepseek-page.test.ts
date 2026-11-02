import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  DEEPSEEK_SNAPSHOT_SCRIPT,
  answerSettled,
  deepSeekHistoryScript,
  deepSeekMessageIdAt,
  deepSeekObservations,
  deepSeekSendScript,
  type DeepSeekPageSnapshot,
  type DeepSeekHistoryResult
} from '../src/main/deepseek/page.js';
import { deepSeekConversationId, deepSeekConversationUrl, isDeepSeekChatPage, isDeepSeekUrl } from '../src/main/deepseek/site.js';

function page(conversationId: string | null, messages: DeepSeekPageSnapshot['messages'], extra: Partial<DeepSeekPageSnapshot> = {}): DeepSeekPageSnapshot {
  return { url: 'https://chat.deepseek.com/', conversationId, inputMarker: null, commandMarker: null, signedIn: true, busy: false, throttled: false, messages, ...extra };
}

const conversationId = 'a97f3e4c-de96-4fc4-ada0-123456789abc';

describe('DeepSeek raw history script', () => {
  function message(id: number, text: string) {
    return { message_id: id, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', has_pending_fragment: false,
      fragments: [{ id: 1, type: 'RESPONSE', content: text }] };
  }

  function history(messages: unknown[], currentId: number | null = 2) {
    return { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: {
      chat_session: { id: conversationId, current_message_id: currentId }, chat_messages: messages
    } } };
  }

  function document(body: unknown) {
    const dom = new JSDOM('', { url: `https://chat.deepseek.com/a/chat/s/${conversationId}`, runScripts: 'outside-only' });
    dom.window.localStorage.setItem('userToken', JSON.stringify({ value: 'synthetic-history-token' }));
    const fetchHistory = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    dom.window.fetch = fetchHistory;
    return { dom, fetchHistory, read: () => dom.window.eval(deepSeekHistoryScript(conversationId)) as Promise<DeepSeekHistoryResult> };
  }

  it('reads the active branch and concatenates only raw RESPONSE fragments with page credentials', async () => {
    const text = '  {"cmd":"echo \\"hi\\" \\\\ *x* __x__ <tag>"}\n';
    const active = { ...message(2, text), fragments: [
      { id: 1, type: 'THINK', content: 'private reasoning' },
      { id: 2, type: 'RESPONSE', content: text.slice(0, 15) },
      { id: 3, type: 'SEARCH', content: 'search details' },
      { id: 4, type: 'RESPONSE', content: text.slice(15) }
    ] };
    const { read, fetchHistory } = document(history([message(8, 'other branch'), active, message(1, 'older')]));
    expect(await read()).toEqual({ ok: true, messageId: 2, role: 'ASSISTANT', status: 'FINISHED', pending: false, text });
    expect(fetchHistory).toHaveBeenCalledExactlyOnceWith(`/api/v0/chat/history_messages?chat_session_id=${conversationId}`, {
      method: 'GET', credentials: 'include', headers: { Authorization: 'Bearer synthetic-history-token' }
    });
  });

  it('uses the highest message id only when the active pointer is missing', async () => {
    const body = history([message(8, 'latest'), message(2, 'older')]);
    delete (body.data.biz_data.chat_session as { current_message_id?: number | null }).current_message_id;
    expect(await document(body).read()).toMatchObject({ ok: true, messageId: 8, text: 'latest' });
    body.data.biz_data.chat_session.current_message_id = 99;
    expect(await document(body).read()).toMatchObject({ ok: false });
  });

  it('preserves WIP, pending fragments and a USER active message for the driver to defer', async () => {
    const active = { ...message(2, ''), role: 'USER', status: 'WIP', has_pending_fragment: true };
    expect(await document(history([active])).read()).toEqual({
      ok: true, messageId: 2, role: 'USER', status: 'WIP', pending: true, text: ''
    });
  });

  it.each([
    null,
    { code: 1, data: { biz_code: 0, biz_data: {} } },
    { code: 0, data: { biz_code: 1, biz_data: {} } },
    { code: 0, data: { biz_code: 0 } },
    history([]),
    history([null]),
    history([{ ...message(2, 'text'), has_pending_fragment: undefined }]),
    history([{ ...message(2, 'text'), status: null }]),
    history([{ ...message(2, 'text'), fragments: [{ type: 'RESPONSE', content: 123 }] }]),
    history([{ ...message(2, 'text'), fragments: [null] }]),
    { ...history([message(2, 'text')]), data: { biz_code: 0, biz_data: {
      chat_session: { id: 'another-conversation', current_message_id: 2 }, chat_messages: [message(2, 'text')]
    } } }
  ])('returns a small failure for unexpected history: %j', async body => {
    expect(await document(body).read()).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('returns failure for HTTP, decoding, network and token errors without exposing the token', async () => {
    const { dom, read, fetchHistory } = document(history([message(2, 'text')]));
    fetchHistory.mockResolvedValueOnce({ ok: false, status: 401 });
    expect(await read()).toEqual({ ok: false, reason: 'http-error' });
    fetchHistory.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('bad json'); } });
    expect(await read()).toEqual({ ok: false, reason: 'history-unavailable' });
    fetchHistory.mockRejectedValueOnce(new Error('synthetic-history-token'));
    expect(await read()).toEqual({ ok: false, reason: 'history-unavailable' });
    dom.window.localStorage.setItem('userToken', 'malformed');
    expect(await read()).toEqual({ ok: false, reason: 'history-unavailable' });
    dom.window.localStorage.setItem('userToken', '{"value":null}');
    expect(await read()).toEqual({ ok: false, reason: 'no-token' });
    expect(fetchHistory).toHaveBeenCalledTimes(3);
  });
});

describe('DeepSeek page snapshot', () => {
  it('records only proven user bubbles and assistant answers, excluding search and timing chrome', () => {
    const dom = new JSDOM('<div class="ds-message" data-virtual-list-item-key="1"><div class="ds-collapsible-text">Research this topic</div></div>' +
      '<div class="ds-message" data-virtual-list-item-key="2"><div class="ds-think-content">Found 14 web pages</div><button>Worked for 5s</button></div>' +
      '<div class="ds-message" data-virtual-list-item-key="3"><div class="ds-assistant-message-main-content"><p>Here is the answer.</p></div></div>' +
      '<div class="ds-message" data-virtual-list-item-key="4"><div class="fbb737a4">Thanks</div></div>',
      { url: `https://chat.deepseek.com/a/chat/s/${conversationId}`, runScripts: 'outside-only' });
    try {
      const snapshot = dom.window.eval(DEEPSEEK_SNAPSHOT_SCRIPT) as DeepSeekPageSnapshot;
      expect(snapshot.messages.map(row => [row.role, row.text])).toEqual([
        ['user', 'Research this topic'], ['assistant', 'Here is the answer.'], ['user', 'Thanks']
      ]);
      expect(JSON.stringify(deepSeekObservations(null, snapshot, 1_000))).not.toMatch(/Found 14|Worked for 5s/);
    } finally { dom.window.close(); }
  });

  it('omits oversized captured markup instead of transporting a cut HTML fragment', () => {
    const dom = new JSDOM('<div class="ds-message" data-virtual-list-item-key="2"><div class="ds-assistant-message-main-content">' +
      'x'.repeat(120_001) + '</div></div>', { url: `https://chat.deepseek.com/a/chat/s/${conversationId}`, runScripts: 'outside-only' });
    try {
      const snapshot = dom.window.eval(DEEPSEEK_SNAPSHOT_SCRIPT) as DeepSeekPageSnapshot;
      expect(snapshot.messages[0]!.renderedHtml).toBeUndefined();
      expect(deepSeekObservations(null, snapshot, 1_000)[0]).toMatchObject({ textFormat: 'plain' });
    } finally { dom.window.close(); }
  });

  it('captures the current assistant structure without including its private reasoning', () => {
    const markup = '<h2>Checks</h2><ul><li>First</li><li>Second</li></ul><table><tbody><tr><td>ok</td></tr></tbody></table>';
    const dom = new JSDOM('<div class="ds-message" data-virtual-list-item-key="2">' +
      '<div class="ds-think-content">private reasoning</div><div class="ds-assistant-message-main-content">' + markup + '</div></div>',
      { url: `https://chat.deepseek.com/a/chat/s/${conversationId}`, runScripts: 'outside-only' });
    try {
      const snapshot = dom.window.eval(DEEPSEEK_SNAPSHOT_SCRIPT) as DeepSeekPageSnapshot;
      const observation = deepSeekObservations(null, snapshot, 1_000).find(row => row.kind === 'assistant_message');
      expect(observation).toMatchObject({ textFormat: 'plain', renderedHtml: markup });
      expect(JSON.stringify(snapshot)).not.toContain('private reasoning');
    } finally { dom.window.close(); }
  });

  it.each([
    ['/a/chat/s/' + conversationId, null, false],
    ['/a/chat/s/' + conversationId, '{"value":null}', false],
    ['/sign_up', '{"value":null}', false],
    ['/a/chat/s/' + conversationId, 'malformed', false],
    ['/a/chat/s/' + conversationId, '{"value":12}', false],
    ['/a/chat/s/' + conversationId, '{"value":""}', false],
    ['/a/chat/s/' + conversationId, '{"value":"synthetic"}', true],
    ['/sign_in', '{"value":"synthetic"}', true]
  ] as const)('uses the token on %s (%s)', (path, token, expected) => {
    const dom = new JSDOM('', { url: `https://chat.deepseek.com${path}`, runScripts: 'outside-only' });
    if (token !== null) dom.window.localStorage.setItem('userToken', token);
    expect((dom.window.eval(DEEPSEEK_SNAPSHOT_SCRIPT) as DeepSeekPageSnapshot).signedIn).toBe(expected);
  });

  it.each([
    ['<div><textarea></textarea><button><svg><rect width="10" height="10" /></svg></button></div>', true],
    ['<div><textarea></textarea><div role="button"><svg><rect width="10" height="10" /></svg></div></div>', true],
    ['<div><textarea></textarea><button><svg><circle r="5" /></svg></button></div>', false],
    ['<div><textarea></textarea><button><svg><rect width="10" height="5" /></svg></button></div>', false],
    ['<div><textarea></textarea><button><svg><rect width="10" height="10" style="fill:none" /></svg></button></div>', false],
    ['<div><textarea></textarea><button aria-label="Send"></button></div><button><svg><rect width="10" height="10" /></svg></button>', false],
    ['<main><div class="ds-message"><button><svg><rect width="10" height="10" /></svg></button></div><textarea></textarea></main>', false],
    ['<div><textarea></textarea><button hidden aria-label="Stop"></button></div>', false],
    ['<div title="Stop generating"></div>', true],
    ['<button aria-label="Send" title="Stop"></button>', true]
  ] as const)('recognizes conservative visible stop controls: %s', (html, expected) => {
    // Supply the SVG default fill explicitly: jsdom's CSS engine treats it as transparent.
    const dom = new JSDOM('<style>svg rect, svg path, svg polygon { fill: black; }</style>' + html,
      { url: 'https://chat.deepseek.com/', runScripts: 'outside-only' });
    Object.defineProperty(dom.window.Element.prototype, 'getClientRects', { configurable: true,
      value(this: Element) { return this.closest('[hidden]') ? [] : [{ width: 10, height: 10 }]; } });
    expect((dom.window.eval(DEEPSEEK_SNAPSHOT_SCRIPT) as DeepSeekPageSnapshot).busy).toBe(expected);
  });

  it('recognizes the rounded stop-square path and rejects a circular path', () => {
    const dom = new JSDOM('<div><textarea></textarea><div role="button"><svg><path style="fill:black" d="M2 4h6v6H2z" /></svg></div></div>',
      { url: 'https://chat.deepseek.com/', runScripts: 'outside-only' });
    Object.defineProperty(dom.window.Element.prototype, 'getClientRects', { configurable: true, value: () => [{ width: 10, height: 10 }] });
    const shape = dom.window.document.querySelector('path')!;
    Object.assign(shape, { getBBox: () => ({ width: 10, height: 10 }), getTotalLength: () => 38 });
    expect((dom.window.eval(DEEPSEEK_SNAPSHOT_SCRIPT) as DeepSeekPageSnapshot).busy).toBe(true);
    Object.assign(shape, { getTotalLength: () => Math.PI * 10 });
    expect((dom.window.eval(DEEPSEEK_SNAPSHOT_SCRIPT) as DeepSeekPageSnapshot).busy).toBe(false);
  });
});

describe('DeepSeek site boundaries', () => {
  it('reads every conversation route the web app uses', () => {
    expect(deepSeekConversationId(`https://chat.deepseek.com/a/chat/s/${conversationId}`)).toBe(conversationId);
    expect(deepSeekConversationId(`https://chat.deepseek.com/chat/s/${conversationId}`)).toBe(conversationId);
    expect(deepSeekConversationId(`https://chat.deepseek.com/s/${conversationId}`)).toBe(conversationId);
  });

  it('never treats home, sign-in, share or another origin as a chat to drive', () => {
    expect(deepSeekConversationId('https://chat.deepseek.com/')).toBeNull();
    expect(deepSeekConversationId('https://chat.deepseek.com/sign_in')).toBeNull();
    expect(deepSeekConversationId('https://chat.deepseek.com/share/5xzlbd61a34eb1vgqn')).toBeNull();
    expect(deepSeekConversationId(`https://chatgpt.com/c/${conversationId}`)).toBeNull();
    expect(deepSeekConversationId('not a url')).toBeNull();
    expect(isDeepSeekChatPage('https://chat.deepseek.com/sign_in')).toBe(false);
    expect(isDeepSeekChatPage(`https://chat.deepseek.com/a/chat/s/${conversationId}`)).toBe(true);
    expect(isDeepSeekUrl('https://chat.deepseek.com/sign_in')).toBe(true);
    expect(isDeepSeekUrl('https://chat.deepseek.com.evil.test/')).toBe(false);
  });

  it('builds the canonical conversation URL', () => {
    expect(deepSeekConversationUrl(conversationId)).toBe(`https://chat.deepseek.com/a/chat/s/${conversationId}`);
  });
});

describe('DeepSeek transcript observations', () => {
  it('keeps a tool-result question in the original local turn without a false completion', () => {
    const snapshot = page(conversationId, [
      { role: 'user', text: '{"type":"tool_results","results":[]}', key: '3' },
      { role: 'assistant', text: '{"type":"tool_calls","calls":[]}', key: '4' }
    ]);
    const observations = deepSeekObservations(snapshot, snapshot, 3_000, true, {
      activeTurnId: 'original-local-turn', intermediate: true
    });
    expect(observations).toEqual([expect.objectContaining({
      kind: 'assistant_message', turnId: 'original-local-turn', state: 'streaming', final: false
    })]);
    const final = deepSeekObservations(snapshot, snapshot, 4_000, true, { activeTurnId: 'original-local-turn' });
    expect(final.at(-1)).toMatchObject({ kind: 'turn_end', turnId: 'original-local-turn', outcome: 'completed' });
  });

  it('never promotes an older tool round to a final answer when its virtual row reappears', () => {
    const snapshot = page(conversationId, [
      { role: 'user', text: 'Read the files', key: '1' },
      { role: 'assistant', text: '{"type":"tool_calls","calls":[]}', key: '2' },
      { role: 'user', text: '{"type":"tool_results","results":[]}', key: '3' },
      { role: 'assistant', text: 'Checking the next file', key: '4' }
    ]);
    const observations = deepSeekObservations(null, snapshot, 3_000, false, { activeTurnId: 'original-local-turn' });
    expect(observations.filter(item => item.kind === 'assistant_message').every(item => item.final === false)).toBe(true);
    expect(observations.some(item => item.kind === 'turn_end')).toBe(false);
  });
  it('streams a keyed answer through one identity and settles it once', () => {
    const first = page(conversationId, [{ role: 'user', text: 'run the tests', key: '1' }]);
    const second = page(conversationId, [
      { role: 'user', text: 'run the tests', key: '1' },
      { role: 'assistant', text: 'Running', key: '2' }
    ]);

    const opened = deepSeekObservations(null, first, 1_000);
    expect(opened).toEqual([
      expect.objectContaining({ kind: 'user_message', text: 'run the tests', time: 1_000 }),
      expect.objectContaining({ kind: 'turn_start' })
    ]);
    expect(opened[1]!.turnId).toBeTruthy();
    const streamed = deepSeekObservations(first, second, 2_000);
    expect(streamed).toEqual([
      expect.objectContaining({ kind: 'assistant_message', text: 'Running', state: 'streaming', final: false,
        messageId: deepSeekMessageIdAt(conversationId, second.messages, 1) })
    ]);
    // A later revision of the same row updates that message; it must not mint a new one.
    const grown = page(conversationId, [
      { role: 'user', text: 'run the tests', key: '1' },
      { role: 'assistant', text: 'Running the full suite', key: '2' }
    ]);
    const next = deepSeekObservations(second, grown, 2_700);
    expect(next).toEqual([
      expect.objectContaining({ kind: 'assistant_message', text: 'Running the full suite', state: 'streaming',
        messageId: streamed[0]!.messageId })
    ]);
    const final = deepSeekObservations(grown, grown, 3_500, true);
    expect(final).toEqual([
      expect.objectContaining({ kind: 'assistant_message', text: 'Running the full suite', state: 'final', final: true,
        messageId: streamed[0]!.messageId, turnId: opened[1]!.turnId }),
      expect.objectContaining({ kind: 'turn_end', outcome: 'completed', turnId: opened[1]!.turnId })
    ]);
  });

  it('does not guess a stream identity when the page has no virtual-list key', () => {
    const first = page(conversationId, [{ role: 'user', text: 'run the tests' }]);
    const second = page(conversationId, [{ role: 'user', text: 'run the tests' }, { role: 'assistant', text: 'Running' }]);
    // Content identity changes on every streamed revision; only the settled answer is recorded.
    expect(deepSeekObservations(first, second, 2_000)).toEqual([]);
    expect(deepSeekObservations(second, second, 3_500, true)).toEqual([
      expect.objectContaining({ kind: 'assistant_message', final: true }),
      expect.objectContaining({ kind: 'turn_end', outcome: 'completed' })
    ]);
  });

  it('records the final answer once even though its text did not change', () => {
    const done = page(conversationId, [{ role: 'user', text: 'hi', key: '1' }, { role: 'assistant', text: 'Hello', key: '2' }]);
    const observations = deepSeekObservations(done, done, 5_000, true);
    const [final] = observations;
    expect(final).toEqual(expect.objectContaining({
      kind: 'assistant_message', text: 'Hello', final: true, state: 'final',
      providerStatus: 'finished_successfully',
      messageId: deepSeekMessageIdAt(conversationId, done.messages, 1)
    }));
    // The page's own answer closes exactly the turn its question opened.
    expect(observations.at(-1)).toEqual(expect.objectContaining({
      kind: 'turn_end', outcome: 'completed', turnId: final!.turnId
    }));
  });

  it('adopts an already answered conversation without opening a live turn', () => {
    const done = page(conversationId, [{ role: 'user', text: 'hi', key: '1' }, { role: 'assistant', text: 'Hello', key: '2' }]);
    const adopted = deepSeekObservations(null, done, 5_000);
    expect(adopted.map(item => item.kind)).toEqual(['user_message', 'assistant_message']);
  });

  it('keeps different answers distinct when DeepSeek drops the oldest visible row', () => {
    // The page keeps only a suffix: the second answer is at index 5 in both snapshots, but the
    // first snapshot's row 5 is report-2 and the second's is finish-2. An index-based id made
    // the finish look like a duplicate of the report and never ran it.
    const report = page(conversationId, [
      { role: 'user', text: 'prompt', key: '0' }, { role: 'assistant', text: 'report-1', key: '1' },
      { role: 'user', text: 'result-1', key: '2' }, { role: 'assistant', text: 'finish-1', key: '3' },
      { role: 'user', text: 'wake', key: '4' }, { role: 'assistant', text: 'report-2', key: '5' }
    ]);
    const next = page(conversationId, [
      { role: 'user', text: 'result-1', key: '2' }, { role: 'assistant', text: 'finish-1', key: '3' },
      { role: 'user', text: 'wake', key: '4' }, { role: 'assistant', text: 'report-2', key: '5' },
      { role: 'user', text: 'result-2', key: '6' }, { role: 'assistant', text: 'finish-2', key: '7' }
    ]);
    const reportId = deepSeekMessageIdAt(conversationId, report.messages, 5);
    const finishId = deepSeekMessageIdAt(conversationId, next.messages, 5);
    expect(reportId).not.toBe(finishId);
    // The same row keeps its id as the visible window shifts one row to the left.
    expect(deepSeekMessageIdAt(conversationId, next.messages, 3)).toBe(reportId);
    const batch = deepSeekObservations(report, next, 4_000, true);
    expect(batch.at(-2)).toEqual(expect.objectContaining({ text: 'finish-2', messageId: finishId }));
    expect(batch.at(-1)).toEqual(expect.objectContaining({ kind: 'turn_end', outcome: 'completed' }));
  });

  it('never mixes two conversations, and ignores pages with no conversation', () => {
    const before = page('11111111-1111-4111-8111-111111111111', [{ role: 'user', text: 'same words' }]);
    const next = page(conversationId, [{ role: 'user', text: 'same words' }]);
    const switched = deepSeekObservations(before, next, 1);
    expect(switched.map(item => item.kind)).toEqual(['user_message']);
    expect(deepSeekObservations(before, page(null, [{ role: 'user', text: 'x' }]), 1)).toEqual([]);
  });

  it('settles only a last answer that was already the same one', () => {
    const previous = page(conversationId, [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'answer' }]);
    const growing = page(conversationId, [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'answer grows' }]);
    expect(answerSettled(previous, previous, 0, 2_000)).toBe(true);
    expect(answerSettled(previous, growing, 0, 2_000)).toBe(false);
    expect(answerSettled(page(conversationId, [{ role: 'user', text: 'q' }]), page(conversationId, [{ role: 'user', text: 'q' }]), 0, 9_000)).toBe(false);
  });
});

describe('DeepSeek composer script', () => {
  it('uses the enabled primary Send when React has not accepted Enter yet', async () => {
    vi.useFakeTimers();
    const dom = new JSDOM('<textarea></textarea><button class="ds-button ds-button--iconLabelPrimary">Attach</button>' +
      '<div class="ds-message"><button class="ds-button ds-button--primary">Transcript control</button></div>' +
      '<button class="ds-button ds-button--primary ds-button--disabled" aria-disabled="true">Disabled</button>' +
      '<button id="send" class="ds-button ds-button--primary ds-button--icon">Send</button>', {
      url: `https://chat.deepseek.com/a/chat/s/${conversationId}`, runScripts: 'outside-only'
    });
    dom.window.setTimeout = setTimeout as unknown as typeof dom.window.setTimeout;
    const sent: string[] = [];
    const wrong = vi.fn();
    const box = dom.window.document.querySelector('textarea')!;
    for (const button of dom.window.document.querySelectorAll('button')) {
      button.addEventListener('click', () => {
        if (button.id !== 'send') { wrong(); return; }
        sent.push(box.value); box.value = '';
      });
    }
    try {
      const result = dom.window.eval(deepSeekSendScript('exact results'));
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ ok: true, reason: 'button' });
      expect(sent).toEqual(['exact results']);
      expect(wrong).not.toHaveBeenCalled();
    } finally { dom.window.close(); vi.useRealTimers(); }
  });

  it.each(['', '<textarea></textarea>'])('withdraws if the document changed before the script started (body=%s)', async body => {
    const dom = new JSDOM(body, { url: 'https://chat.deepseek.com/a/chat/s/other', runScripts: 'outside-only' });
    try {
      expect(await dom.window.eval(deepSeekSendScript('exact results', undefined,
        `https://chat.deepseek.com/a/chat/s/${conversationId}`))).toMatchObject({ ok: false, reason: 'navigation', withdrawn: true });
      expect(dom.window.document.querySelector('textarea')?.value ?? '').toBe('');
    } finally { dom.window.close(); }
  });

  it('accepts Enter that clears the composer while opening a new conversation', async () => {
    const dom = new JSDOM('<textarea></textarea>', { url: 'https://chat.deepseek.com/', runScripts: 'outside-only' });
    const navigation = new dom.window.EventTarget();
    Object.defineProperty(dom.window, 'navigation', { value: navigation });
    const box = dom.window.document.querySelector('textarea')!;
    box.addEventListener('keydown', () => {
      navigation.dispatchEvent(new dom.window.Event('navigate'));
      dom.window.history.pushState({}, '', `/a/chat/s/${conversationId}`);
      box.value = '';
    });
    try {
      expect(await dom.window.eval(deepSeekSendScript('new task'))).toMatchObject({ ok: true, reason: 'enter' });
    } finally { dom.window.close(); }
  });

  it.each([false, true])('withdraws before typing after navigation during DeepThink setup (return to A=%s)', async returnToA => {
    vi.useFakeTimers();
    const dom = new JSDOM('<textarea></textarea><button aria-pressed="false">DeepThink</button>', {
      url: `https://chat.deepseek.com/a/chat/s/${conversationId}`, runScripts: 'outside-only'
    });
    // JSDOM lacks Chromium's Navigation API. Emit its native event alongside these SPA moves.
    const navigation = new dom.window.EventTarget();
    Object.defineProperty(dom.window, 'navigation', { value: navigation });
    dom.window.setTimeout = setTimeout as unknown as typeof dom.window.setTimeout;
    const sends: string[] = [];
    const box = dom.window.document.querySelector('textarea')!;
    box.addEventListener('keydown', () => { sends.push(box.value); box.value = ''; });
    dom.window.document.querySelector('button')!.addEventListener('click', () => {
      setTimeout(() => {
        navigation.dispatchEvent(new dom.window.Event('navigate'));
        dom.window.history.pushState({}, '', '/a/chat/s/other');
        if (returnToA) {
          navigation.dispatchEvent(new dom.window.Event('navigate'));
          dom.window.history.pushState({}, '', `/a/chat/s/${conversationId}`);
        }
        dom.window.document.querySelector('button')!.setAttribute('aria-pressed', 'true');
      }, 10);
    });
    try {
      const result = dom.window.eval(deepSeekSendScript('exact results', { model: 'deepseek-flash', reasoningEffort: 'high' }));
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ ok: false, reason: 'navigation', withdrawn: true });
      expect(sends).toEqual([]);
      expect(box.value).toBe('');
    } finally { dom.window.close(); vi.useRealTimers(); }
  });

  it.each([false, true])("never clicks another chat's Send after an unconfirmed Enter (return to A=%s)", async returnToA => {
    vi.useFakeTimers();
    const dom = new JSDOM('<textarea></textarea>', {
      url: `https://chat.deepseek.com/a/chat/s/${conversationId}`, runScripts: 'outside-only'
    });
    const navigation = new dom.window.EventTarget();
    Object.defineProperty(dom.window, 'navigation', { value: navigation });
    dom.window.setTimeout = setTimeout as unknown as typeof dom.window.setTimeout;
    const clicked = vi.fn();
    dom.window.document.querySelector('textarea')!.addEventListener('keydown', () => {
      setTimeout(() => {
        navigation.dispatchEvent(new dom.window.Event('navigate'));
        dom.window.history.pushState({}, '', '/a/chat/s/other');
        if (returnToA) {
          navigation.dispatchEvent(new dom.window.Event('navigate'));
          dom.window.history.pushState({}, '', `/a/chat/s/${conversationId}`);
        }
        dom.window.document.body.innerHTML = '<textarea>another draft</textarea><button class="ds-button--primary">Send</button>';
        dom.window.document.querySelector('button')!.addEventListener('click', clicked);
      }, 10);
    });
    try {
      const result = dom.window.eval(deepSeekSendScript('exact results'));
      await vi.runAllTimersAsync();
      expect(clicked).not.toHaveBeenCalled();
      expect(await result).toMatchObject({ ok: false, reason: 'navigation', withdrawn: false });
      expect(dom.window.document.querySelector('textarea')!.value).toBe('another draft');
    } finally { dom.window.close(); vi.useRealTimers(); }
  });
  it('carries the exact message, including quotes and newlines', () => {
    const text = 'line one\nsay "hi" \\ now\'s the time';
    const script = deepSeekSendScript(text);
    expect(script).toContain(JSON.stringify(text));
    // The injected source must stay one expression that executeJavaScript can run.
    expect(script.startsWith('(async () => {')).toBe(true);
    expect(script.endsWith('})()')).toBe(true);
  });
});
