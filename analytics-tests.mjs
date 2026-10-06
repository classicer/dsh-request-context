import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { CATEGORIES, estimateTextTokens, summarizeChunk, estimateAnalytics, isValidAnalytics } from './analytics.js';
import { ContextStore, digest, maskJson } from './store.js';
import { apply } from './index.js';

const root = resolve(import.meta.dirname, '.test-state');
await mkdir(root, { recursive: true });
const fresh = async () => new ContextStore(await mkdtemp(join(root, 'analytics-')));
const msg = (role, text, source) => ({ role, ...(source === undefined ? {} : { source: typeof source === 'string' ? { kind: source } : source }), content: [{ type: 'text', text }] });
const input = overrides => ({ provider: 'test', model: 'test', sessionId: 'analytics-session', messages: [], ...overrides });
const category = (analytics, id) => analytics.categories.find(item => item.id === id);
function analyze(request) {
  const refs = { messages: [] }, chunks = new Map();
  const add = (value, kind) => {
    const hash = digest(JSON.stringify(value));
    chunks.set(hash + '/' + kind, summarizeChunk(value, kind));
    return hash;
  };
  refs.messages = (request.messages ?? []).map(value => add(value, 'message'));
  for (const kind of ['system', 'tools', 'toolHistory']) if (request[kind] !== undefined) refs[kind + 'Ref'] = add(request[kind], kind);
  return estimateAnalytics(refs, (hash, kind) => chunks.get(hash + '/' + kind));
}
const checkSum = analytics => assert.equal(analytics.estimatedInputTokens, analytics.categories.reduce((total, item) => total + item.tokens, 0));

// No provider calls, live user data or credentials are used.
test('empty input has the exact fixed analytics contract and category order', () => {
  const analytics = analyze({ messages: [], tools: [] });
  assert.deepEqual(Object.keys(analytics), ['version', 'method', 'estimatedInputTokens', 'messageCount', 'categories', 'toolHistoryTokens', 'attachmentCount', 'unknownBlockCount']);
  assert.equal(analytics.version, 1);
  assert.equal(analytics.method, 'heuristic-v1');
  assert.equal(analytics.estimatedInputTokens, 0);
  assert.equal(analytics.messageCount, 0);
  assert.equal(analytics.attachmentCount, 0);
  assert.equal(analytics.unknownBlockCount, 0);
  assert.equal(analytics.toolHistoryTokens, 0);
  assert.deepEqual(analytics.categories.map(item => item.id), ['system', 'developer', 'toolDefinitions', 'toolCalls', 'toolResults', 'subagent', 'user', 'assistant', 'context', 'other']);
  assert.deepEqual(analytics.categories, CATEGORIES.map(item => ({ ...item, tokens: 0, messageCount: 0 })));
  checkSum(analytics);
});

test('Unicode counts codepoints rather than UTF-16 units; JSON message metadata does not count', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('abcd'), 1);
  assert.equal(estimateTextTokens('abcde'), 2);
  assert.equal(estimateTextTokens('中😀é'), 3);
  assert.equal(estimateTextTokens('abcd中😀'), 3);
  const plain = analyze({ messages: [msg('user', 'abcd中😀')] });
  const metadata = analyze({ messages: [{ ...msg('user', 'abcd中😀'), id: 'x'.repeat(1000), timestamp: 'y'.repeat(1000), source: { kind: 'user', ignored: 'z'.repeat(1000) } }] });
  assert.equal(plain.estimatedInputTokens, 7);
  assert.deepEqual(metadata, plain);
});

test('message growth raises estimates and compacted history lowers them', () => {
  const first = analyze({ messages: [msg('user', 'a'.repeat(200))] });
  const grown = analyze({ messages: [msg('user', 'a'.repeat(200)), msg('assistant', 'b'.repeat(400)), msg('user', 'c'.repeat(100))] });
  const compacted = analyze({ messages: [msg('user', '简短摘要', 'compaction-summary')] });
  assert.ok(grown.estimatedInputTokens > first.estimatedInputTokens);
  assert.ok(compacted.estimatedInputTokens < grown.estimatedInputTokens);
  assert.equal(grown.messageCount, 3);
  assert.equal(category(compacted, 'context').messageCount, 1);
  [first, grown, compacted].forEach(checkSum);
});

test('mixed assistant content splits calls while framing and category message counts never double charge', () => {
  const analytics = analyze({ messages: [{ role: 'assistant', source: { kind: 'model' }, content: [
    { type: 'text', text: 'abcd' }, { type: 'reasoning', text: '中' },
    { type: 'tool-call', id: 'a', name: 'read', arguments: 'abcd' },
    { type: 'tool-call', id: 'b', name: 'write', arguments: 'abcd' },
    { type: 'tool-call', id: 'c', name: 'subagent', arguments: 'abcd' },
  ] }] });
  assert.equal(category(analytics, 'assistant').tokens, 6);
  assert.equal(category(analytics, 'toolCalls').tokens, 5);
  assert.equal(category(analytics, 'subagent').tokens, 3);
  assert.equal(analytics.estimatedInputTokens, 14);
  assert.equal(analytics.messageCount, 1);
  assert.equal(category(analytics, 'assistant').messageCount, 1);
  assert.equal(category(analytics, 'toolCalls').messageCount, 1);
  assert.equal(category(analytics, 'subagent').messageCount, 1);
  const callOnly = analyze({ messages: [{ role: 'assistant', content: [{ type: 'tool-call', id: 'd', name: 'read', arguments: '' }] }] });
  assert.equal(category(callOnly, 'toolCalls').tokens, 5);
  assert.equal(category(callOnly, 'assistant').messageCount, 0);
  [analytics, callOnly].forEach(checkSum);
});

test('tools compact JSON are counted once; toolHistory is a separate excluded diagnostic', () => {
  const tools = [{ name: 'read', description: '读取', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
  const plain = analyze({ messages: [], tools });
  const history = analyze({ messages: [], tools, toolHistory: { tools, updates: [{ messageId: 'm', additions: tools }] } });
  assert.equal(category(plain, 'toolDefinitions').tokens, estimateTextTokens(JSON.stringify(tools)));
  assert.equal(history.estimatedInputTokens, plain.estimatedInputTokens);
  assert.ok(history.toolHistoryTokens > 0);
  assert.equal(category(history, 'toolDefinitions').messageCount, 0);
  const withoutTools = analyze({ messages: [], toolHistory: { tools, updates: [] } });
  assert.equal(withoutTools.estimatedInputTokens, 0);
  assert.ok(withoutTools.toolHistoryTokens > 0);
  checkSum(history);
});

test('roles and explicit sources classify instructions, human input and automatic context without guessing text', () => {
  const analytics = analyze({ system: '规则', messages: [
    msg('system', 'abcd'), msg('developer', 'abcd'), msg('user', 'abcd', 'system-prompt'),
    msg('user', 'abcd', 'agent-instructions'), msg('user', 'abcd', 'skill-invocation'),
    msg('user', 'abcd'), msg('user', 'abcd', 'user'), msg('user', 'abcd', 'user-rpc'),
    msg('user', 'subagent developer system workflow', 'automatic'),
    msg('user', 'abcd', 'subagent-result'), msg('unknown', 'abcd'),
  ] });
  assert.equal(category(analytics, 'system').messageCount, 2);
  assert.equal(category(analytics, 'system').tokens, 12);
  assert.equal(category(analytics, 'developer').messageCount, 3);
  assert.equal(category(analytics, 'user').messageCount, 3);
  assert.equal(category(analytics, 'context').messageCount, 1);
  assert.equal(category(analytics, 'subagent').messageCount, 1);
  assert.equal(category(analytics, 'other').messageCount, 1);
  assert.equal(analytics.messageCount, 11);
  checkSum(analytics);
  const explicit = analyze({ messages: [msg('user', 'abcd', 'subagent-notification'), msg('user', 'abcd', 'subagent-update'), msg('user', 'abcd', 'agent-message')] });
  assert.equal(category(explicit, 'subagent').messageCount, 2);
  assert.equal(category(explicit, 'context').messageCount, 1, 'generic agent source is not sufficient evidence of a subagent');
  checkSum(explicit);
});

test('subagent tools resolve preceding call ids from standard id and source.callId; unrelated names stay tools', () => {
  const calls = ['subagent', 'subagent_fork', 'workflow', 'send_message', 'list_agents', 'interrupt_agent', 'functions.subagent'];
  const messages = calls.flatMap((name, index) => [
    { role: 'assistant', content: [{ type: 'tool-call', id: String(index), name, arguments: '{}' }] },
    { ...msg('tool', 'result', { kind: 'tool', callId: String(index) }) },
  ]);
  messages.push(
    { role: 'assistant', content: [{ type: 'tool-call', callId: 'regular', name: 'read_subagent_notes', arguments: 'workflow subagent' }] },
    { ...msg('tool', 'subagent response'), toolCallId: 'regular' },
    { ...msg('tool', 'subagent'), toolCallId: 'unknown' },
    { ...msg('tool', 'subagent'), toolCallId: 'future' },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'future', name: 'subagent', arguments: '{}' }] },
  );
  const analytics = analyze({ messages });
  assert.equal(category(analytics, 'subagent').messageCount, calls.length * 2 + 1);
  assert.equal(category(analytics, 'toolCalls').messageCount, 1);
  assert.equal(category(analytics, 'toolResults').messageCount, 3);
  assert.equal(category(analytics, 'assistant').messageCount, 0);
  checkSum(analytics);
});

test('attachments have no fabricated visual tokens and unknown blocks conservatively estimate compact JSON', () => {
  const unknown = { type: 'future', value: '中文😀abcd' };
  const analytics = analyze({ messages: [{ role: 'user', content: [
    { type: 'image', attachment: { attachmentId: 'huge'.repeat(500), bytes: 123456789, width: 9000, height: 9000 } },
    { type: 'file', attachment: { name: 'big.pdf', bytes: 999999999 } }, unknown,
  ] }] });
  assert.equal(analytics.attachmentCount, 2);
  assert.equal(analytics.unknownBlockCount, 1);
  assert.equal(analytics.estimatedInputTokens, 4 + estimateTextTokens(JSON.stringify(unknown)));
  const attachmentsOnly = analyze({ messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }] });
  assert.equal(attachmentsOnly.estimatedInputTokens, 4);
  checkSum(analytics);
});

test('capture persists masked-copy analytics synchronously; list/get/restart share the same estimates', async () => {
  const store = await fresh();
  const options = input({ messages: [msg('user', 'Bearer synthetic-credential-abcdef'), { role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'read', arguments: '{"apiKey":"synthetic-secret"}' }] }], tools: [{ name: 'read', parameters: {} }] });
  const safe = maskJson(options);
  const id = store.capture(options);
  assert.deepEqual([...store.pending.values()][0].analytics, analyze(safe));
  options.messages[0].content[0].text = 'mutated';
  options.tools[0].name = 'changed';
  await store.flush();
  const stored = JSON.parse(await readFile(store.recordPath(options.sessionId, id), 'utf8'));
  assert.deepEqual(stored.analytics, analyze(safe));
  assert.equal(JSON.stringify([...store.analyticsChunks]).includes('synthetic-secret'), false);
  let blobReads = 0;
  const originalRead = store.readBlob.bind(store);
  store.readBlob = async hash => { blobReads++; return originalRead(hash); };
  assert.deepEqual((await store.list(options.sessionId)).records[0].analytics, stored.analytics);
  assert.deepEqual((await store.list(options.sessionId)).records[0].analytics, stored.analytics);
  assert.equal(blobReads, 0);
  assert.deepEqual((await store.get(options.sessionId, id)).meta.analytics, stored.analytics);
  const restarted = new ContextStore(store.root);
  restarted.readBlob = async () => { throw new Error('list must not read CAS for persisted analytics'); };
  assert.deepEqual((await restarted.list(options.sessionId)).records[0].analytics, stored.analytics);
  await restarted.dispose();
  const readable = new ContextStore(store.root);
  assert.deepEqual((await readable.get(options.sessionId, id)).meta.analytics, stored.analytics);
  await readable.dispose(); await store.dispose();
});

test('shared CAS hashes reuse estimation work but repeated message occurrences still count', async () => {
  const store = await fresh();
  const repeated = msg('user', 'abcd');
  const one = store.capture(input({ messages: [repeated] }));
  const cacheSize = store.analyticsChunks.size;
  const two = store.capture(input({ messages: [repeated, repeated] }));
  assert.equal(store.analyticsChunks.size, cacheSize);
  const first = (await store.get('analytics-session', one)).meta.analytics;
  const second = (await store.get('analytics-session', two)).meta.analytics;
  assert.equal(second.estimatedInputTokens, first.estimatedInputTokens * 2);
  assert.equal(second.messageCount, 2);
  assert.equal(category(second, 'user').messageCount, 2);
  await store.dispose();
});

test('cached tool result summaries retain request-local preceding-call classification', () => {
  const result = { ...msg('tool', 'abcd'), toolCallId: 'shared-call' };
  const cache = new Map();
  function withCall(name) {
    const messages = [{ role: 'assistant', content: [{ type: 'tool-call', id: 'shared-call', name, arguments: '{}' }] }, result];
    const refs = { messages: messages.map(message => {
      const hash = digest(JSON.stringify(message));
      if (!cache.has(hash)) cache.set(hash, summarizeChunk(message, 'message'));
      return hash;
    }) };
    return estimateAnalytics(refs, hash => cache.get(hash));
  }
  assert.equal(category(withCall('subagent'), 'subagent').messageCount, 2);
  assert.equal(category(withCall('read'), 'toolResults').messageCount, 1);
});

async function legacyFixture(messages, extra = {}) {
  const store = await fresh();
  const first = store.capture(input({ messages, ...extra }));
  const second = store.capture(input({ messages, ...extra }));
  await store.flush();
  const bytes = new Map(), expected = new Map();
  for (const id of [first, second]) {
    const record = JSON.parse(await readFile(store.recordPath('analytics-session', id), 'utf8'));
    expected.set(id, record.analytics);
    delete record.analytics;
    const text = JSON.stringify(record);
    await writeFile(store.recordPath('analytics-session', id), text);
    bytes.set(id, text);
  }
  await store.dispose();
  return { restarted: new ContextStore(store.root), ids: [first, second], bytes, expected };
}

test('legacy schemaVersion 1 list backfills once from original refs, shares hash reads and does not rewrite disk', async () => {
  const repeated = msg('user', 'abcd');
  const { restarted, ids, bytes, expected } = await legacyFixture([repeated, repeated], { system: '中', tools: [{ name: 'read', parameters: {} }], toolHistory: { tools: [], updates: [] } });
  let blobReads = 0;
  const originalRead = restarted.readBlob.bind(restarted);
  restarted.readBlob = async hash => { blobReads++; return originalRead(hash); };
  const [first, concurrent] = await Promise.all([restarted.list('analytics-session'), restarted.list('analytics-session')]);
  assert.equal(blobReads, 4);
  assert.deepEqual(first, concurrent);
  for (const record of first.records) assert.deepEqual(record.analytics, expected.get(record.id));
  assert.equal(category(first.records[0].analytics, 'user').messageCount, 2);
  await restarted.list('analytics-session');
  assert.equal(blobReads, 4, 'polling must not reload message bodies');
  for (const id of ids) assert.equal(await readFile(restarted.recordPath('analytics-session', id), 'utf8'), bytes.get(id));
  assert.deepEqual((await restarted.get('analytics-session', ids[0])).meta.analytics, expected.get(ids[0]));
  const afterGet = blobReads;
  await restarted.list('analytics-session');
  assert.equal(blobReads, afterGet);
  await restarted.dispose();
});

test('legacy get-first computes analytics from its already hydrated bodies, then list reuses summaries', async () => {
  const { restarted, ids, bytes, expected } = await legacyFixture([msg('user', '😀abcd')]);
  let blobReads = 0;
  const originalRead = restarted.readBlob.bind(restarted);
  restarted.readBlob = async hash => { blobReads++; return originalRead(hash); };
  const result = await restarted.get('analytics-session', ids[0]);
  assert.equal(blobReads, 1, 'get should not read the same refs again for analytics');
  assert.deepEqual(result.meta.analytics, expected.get(ids[0]));
  assert.ok(result.notes.some(note => note.includes('messageCount') && note.includes('跨类')));
  assert.ok(result.notes.some(note => note.includes('reasoning') && note.includes('适配器可能移除')));
  await restarted.list('analytics-session');
  await restarted.list('analytics-session');
  assert.equal(blobReads, 1);
  assert.equal(await readFile(restarted.recordPath('analytics-session', ids[0]), 'utf8'), bytes.get(ids[0]));
  await restarted.dispose();
});

test('legacy corrupt CAS degrades only analytics, caches unavailable state, and get still rejects', async () => {
  const { restarted, ids } = await legacyFixture([msg('user', 'abcd')]);
  const healthyInput = input({ messages: [msg('user', 'healthy different content')] });
  const healthyId = restarted.capture(healthyInput);
  await restarted.flush();
  const record = JSON.parse(await readFile(restarted.recordPath('analytics-session', ids[0]), 'utf8'));
  await writeFile(restarted.blobPath(record.request.messages[0]), '{"invalid":"bytes"}');
  let reads = 0;
  const originalRead = restarted.readBlob.bind(restarted);
  restarted.readBlob = async hash => { reads++; return originalRead(hash); };
  const list = await restarted.list('analytics-session');
  assert.equal(list.records.length, 3);
  for (const id of ids) {
    const unavailable = list.records.find(item => item.id === id);
    assert.equal(unavailable.analyticsUnavailable, true);
    assert.equal(unavailable.analytics, undefined);
    assert.ok(list.failures.some(failure => failure.id === id && failure.code === 'ANALYTICS_UNAVAILABLE'));
  }
  assert.ok(isValidAnalytics(list.records.find(item => item.id === healthyId).analytics));
  const afterFirst = reads;
  await restarted.list('analytics-session');
  assert.equal(reads, afterFirst, 'unavailable analytics should not retry bodies each poll');
  assert.deepEqual((await restarted.get('analytics-session', healthyId)).request, healthyInput);
  await assert.rejects(restarted.get('analytics-session', ids[0]), /integrity/);
  await restarted.dispose();
});

test('persisted analytics validator rejects malformed contracts and inconsistent numbers', () => {
  const good = analyze({ messages: [msg('user', 'abcd')] });
  assert.equal(isValidAnalytics(good), true);
  for (const bad of [null, {}, [], { ...good, version: 2 }, { ...good, method: 'unknown' }, { ...good, categories: [] }]) assert.equal(isValidAnalytics(bad), false);
  for (const key of ['estimatedInputTokens', 'messageCount', 'toolHistoryTokens', 'attachmentCount', 'unknownBlockCount']) {
    for (const value of [-1, 0.5, NaN, Infinity, '5']) assert.equal(isValidAnalytics({ ...good, [key]: value }), false);
  }
  const reversed = structuredClone(good);
  reversed.categories.reverse();
  assert.equal(isValidAnalytics(reversed), false);
  const inconsistent = structuredClone(good);
  inconsistent.categories[0].tokens++;
  assert.equal(isValidAnalytics(inconsistent), false);
  const excessiveCount = structuredClone(good);
  excessiveCount.categories[0].messageCount = 2;
  assert.equal(isValidAnalytics(excessiveCount), false);
});

test('malformed persisted analytics is backfilled from refs for list and get without rewriting disk', async () => {
  const { restarted, ids, expected } = await legacyFixture([msg('user', 'abcd')]);
  const bytes = new Map();
  for (const [index, id] of ids.entries()) {
    const record = JSON.parse(await readFile(restarted.recordPath('analytics-session', id), 'utf8'));
    record.analytics = index === 0 ? {} : { ...expected.get(id), estimatedInputTokens: 999 };
    const text = JSON.stringify(record);
    await writeFile(restarted.recordPath('analytics-session', id), text);
    bytes.set(id, text);
  }
  let reads = 0;
  const originalRead = restarted.readBlob.bind(restarted);
  restarted.readBlob = async hash => { reads++; return originalRead(hash); };
  const got = await restarted.get('analytics-session', ids[0]);
  assert.deepEqual(got.meta.analytics, expected.get(ids[0]));
  const list = await restarted.list('analytics-session');
  assert.equal(reads, 1);
  for (const record of list.records) {
    assert.equal(isValidAnalytics(record.analytics), true);
    assert.deepEqual(record.analytics, expected.get(record.id));
    assert.equal(record.analyticsUnavailable, undefined);
  }
  await restarted.list('analytics-session');
  assert.equal(reads, 1);
  for (const id of ids) assert.equal(await readFile(restarted.recordPath('analytics-session', id), 'utf8'), bytes.get(id));
  await restarted.dispose();
});

test('bad JSON, filename identity and malformed refs are isolated beside a healthy snapshot', async () => {
  const store = await fresh();
  const ids = Array.from({ length: 4 }, (_, index) => store.capture(input({ messages: [msg('user', 'content ' + index)] })));
  await store.flush();
  await writeFile(store.recordPath('analytics-session', ids[0]), '{invalid sensitive-prompt-byte');
  const wrongId = JSON.parse(await readFile(store.recordPath('analytics-session', ids[1]), 'utf8'));
  wrongId.id = ids[3];
  await writeFile(store.recordPath('analytics-session', ids[1]), JSON.stringify(wrongId));
  const badRefs = JSON.parse(await readFile(store.recordPath('analytics-session', ids[2]), 'utf8'));
  badRefs.request.messages = {};
  await writeFile(store.recordPath('analytics-session', ids[2]), JSON.stringify(badRefs));
  const restarted = new ContextStore(store.root);
  const list = await restarted.list('analytics-session');
  assert.deepEqual(list.records.map(record => record.id), [ids[3]]);
  assert.equal(list.failures.length, 3);
  for (const id of ids.slice(0, 3)) assert.ok(list.failures.some(failure => failure.id === id && failure.code === 'SNAPSHOT_READ_FAILED'));
  assert.equal(JSON.stringify(list).includes('sensitive-prompt-byte'), false);
  assert.equal((await restarted.get('analytics-session', ids[3])).request.messages[0].content[0].text, 'content 3');
  await assert.rejects(restarted.get('analytics-session', ids[0]));
  await assert.rejects(restarted.get('analytics-session', ids[1]), /Invalid stored request/);
  await assert.rejects(restarted.get('analytics-session', ids[2]), /Invalid stored request/);
  await restarted.dispose(); await store.dispose();
});

test('capture analytics finishes before next and does not consume, wrap or mutate the stream/input', async () => {
  const store = await fresh();
  const hooks = new Map(), disposers = [];
  let route;
  const ctx = { sessions: { get: () => ({ seq: 4 }) }, on: (event, callback) => hooks.set(event, callback), effect: callback => { disposers.push(callback()); }, connection: { fetch: { register: value => { route = value; return async () => {}; } } } };
  apply(ctx, { dataDir: store.root });
  const options = input({ messages: [msg('user', 'abcd')] });
  const original = structuredClone(options);
  const stream = { [Symbol.asyncIterator]() { throw new Error('observer consumed stream'); } };
  let nextCalls = 0;
  const observed = hooks.get('llm/stream')(options, () => {
    nextCalls++;
    assert.deepEqual(options, original);
    options.messages[0].content[0].text = 'mutated inside next to be much longer';
    return stream;
  });
  assert.equal(observed, stream);
  assert.equal(nextCalls, 1);
  const records = await (await route.fetch(new Request('http://localhost/api/local-request-context?sessionId=analytics-session'))).json();
  assert.deepEqual(records.records[0].analytics, analyze(original));
  for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose();
  await store.dispose();
});
