const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./runtime.cjs');
const { HistoryPresentation } = require('../src/history-presentation.ts');
const { ChatViewProvider } = require('../src/chat-view-provider.ts');
const image = id => ({ id, direction: 'received', type: 2, content: '[图片]', timestamp: 1700000000,
  context_token: '', from_user_id: 'peer', to_user_id: 'bot' });
const text = (id, content) => ({ ...image(id), type: 1, content });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('large multipart history bounds simultaneous image reads and preserves order and source records', async () => {
  let active = 0, peak = 0, calls = 0;
  const presentation = new HistoryPresentation(async (id, index) => {
    active++; calls++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return `data:image/png;base64,${id}-${index}`;
  }, () => assert.fail('no image errors expected'));
  const input = Array.from({ length: 40 }, (_, i) => ({ ...image(i + 1), parts: [
    { type: 1, text: `**message ${i}**` }, { type: 2 }, { type: 2 },
  ] }));
  const before = JSON.stringify(input);
  const output = await presentation.hydrate(input, 'generation:1');
  assert.equal(calls, 80);
  assert.equal(peak, 4);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(output.map(row => row.id), input.map(row => row.id));
  assert.equal(output[39].parts[2].imageDataUrl, 'data:image/png;base64,40-2');
  assert.ok(output[0].parts[0].markdown.length);
});

test('unchanged history reuses media and markdown while a content revision invalidates only media', async () => {
  let reads = 0, parses = 0;
  const presentation = new HistoryPresentation(async () => { reads++; return 'data:image/png;base64,YWJj'; },
    () => {}, source => { parses++; return [{ tag: 'text', text: source }]; });
  const rows = [text(1, 'same source'), text(2, 'same source'), image(3)];
  await presentation.hydrate(rows, 'g:1');
  await presentation.hydrate(rows, 'g:1');
  assert.equal(reads, 1);
  assert.equal(parses, 1);
  await presentation.hydrate(rows, 'g:2');
  assert.equal(reads, 2);
  assert.equal(parses, 1);
  await presentation.hydrate(rows, 'new-generation:2');
  assert.equal(reads, 3);
  presentation.clear();
  await presentation.hydrate(rows, 'new-generation:2');
  assert.equal(reads, 4);
  assert.equal(parses, 2);
});

test('missing and failing caches are retried without dropping other messages or remote fallbacks', async () => {
  let ready = false, errors = 0;
  const presentation = new HistoryPresentation(async id => {
    if (!ready && id === 1) throw new Error('not ready');
    return ready ? 'data:image/png;base64,YWJj' : undefined;
  }, () => { errors++; });
  const input = [{ ...image(1), content: 'https://example.invalid/image.png' }, image(2), text(3, 'body')];
  const first = await presentation.hydrate(input, 'g:1');
  assert.equal(errors, 1);
  assert.equal(first[0].imageDataUrl, input[0].content);
  assert.equal(first[1].imageDataUrl, undefined);
  assert.equal(first[2].content, 'body');
  ready = true;
  const later = await presentation.hydrate(input, 'g:1');
  assert.equal(later[1].imageDataUrl, 'data:image/png;base64,YWJj');
});

test('a late older revision cannot poison the current image cache', async () => {
  const pending = deferred(); let reads = 0;
  const presentation = new HistoryPresentation(async () => ++reads === 1 ? pending.promise : 'new-image', () => {});
  const old = presentation.hydrate([image(1)], 'old');
  const current = await presentation.hydrate([image(1)], 'new');
  pending.resolve('old-image');
  assert.equal((await old)[0].imageDataUrl, 'old-image');
  assert.equal(current[0].imageDataUrl, 'new-image');
  assert.equal((await presentation.hydrate([image(1)], 'new'))[0].imageDataUrl, 'new-image');
  assert.equal(reads, 2);
});

test('WeChat and imported images cannot bypass host downloads through remote history fallbacks', async () => {
  const remote = 'https://untrusted.invalid/redirect-to-private-network';
  const local = 'data:image/png;base64,YWJj';
  for (const imported of [false, true]) {
    const presentation = new HistoryPresentation(async id => id === 3 ? local : remote,
      () => {}, undefined, imported);
    const input = [
      { ...image(1), restored: imported, content: remote, imageDataUrl: remote },
      { ...image(2), restored: imported, parts: [{ type: 2, url: remote, imageDataUrl: remote }, { type: 1, text: 'kept' }] },
      { ...image(3), restored: imported },
    ];
    const before = JSON.stringify(input);
    const output = await presentation.hydrate(input, 'safe');
    assert.equal(output[0].imageDataUrl, undefined);
    assert.equal(output[0].content, '[图片]');
    assert.equal(output[1].parts[0].url, undefined);
    assert.equal(output[1].parts[0].imageDataUrl, undefined);
    assert.equal(output[1].parts[1].text, 'kept');
    assert.equal(output[2].imageDataUrl, local);
    assert.equal(JSON.stringify(input), before, 'display projection must not rewrite stored history');
  }
});

test('media cache evicts by byte budget and entry count rather than growing with history', async () => {
  let reads = 0;
  const value = 'x'.repeat(1024 * 1024);
  const presentation = new HistoryPresentation(async () => { reads++; return value; }, () => {});
  for (let id = 1; id <= 9; id++) await presentation.hydrate([image(id)], 'g');
  await presentation.hydrate([image(9)], 'g');
  assert.equal(reads, 9);
  await presentation.hydrate([image(1)], 'g');
  assert.equal(reads, 10);
  const small = new HistoryPresentation(async () => { reads++; return 'tiny'; }, () => {});
  for (let id = 1; id <= 129; id++) await small.hydrate([image(id)], 'g');
  const before = reads;
  await small.hydrate([image(129)], 'g');
  await small.hydrate([image(1)], 'g');
  assert.equal(reads, before + 1);
});

test('markdown memoization is bounded and oversized text keeps its plain-text fallback', async () => {
  let parses = 0;
  const presentation = new HistoryPresentation(async () => undefined, () => {}, source => {
    parses++; return [{ tag: 'text', text: source }];
  });
  await presentation.hydrate(Array.from({ length: 257 }, (_, i) => text(i + 1, `source-${i}`)), 'g');
  await presentation.hydrate([text(300, 'source-256'), text(301, 'source-0')], 'g');
  assert.equal(parses, 258);
  const content = 'x'.repeat(32769);
  const output = await presentation.hydrate([text(302, content)], 'g');
  assert.equal(output[0].markdown, undefined);
  assert.equal(output[0].content, content);
});

test('ready presents current connection health independently from history and recipients', async () => {
  const posted = [];
  const health = { state: 'reconnecting', detail: '正在重连', retryAt: Date.now() + 1000 };
  const provider = new ChatViewProvider({}, { channelName: 'QQ', connected: false, connectionHealth: health }, {
    async getChangeStamp() { return 'stamp'; },
    async getSyncSnapshot() { return { cursor: { generation: 'g', contentVersion: 0, lastId: 0 }, reset: true,
      messages: [], unreadCount: 0, readThroughId: 0, hasMore: false }; },
  });
  provider.view = { webview: { postMessage: message => posted.push(message) } };
  await provider.handleWebViewMessage({ command: 'ready' });
  assert.deepEqual(posted.find(message => message.command === 'connectionHealth').connectionHealth, health);
  assert.ok(posted.some(message => message.command === 'syncMessages'));
});
