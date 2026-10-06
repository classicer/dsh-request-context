import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateAnalytics, summarizeChunk, isValidAnalytics } from './analytics.js';
import { TurnTracker, compareCaptures } from './turns.js';

export const REQUEST_KEYS = ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop', 'sessionId', 'purpose'];
const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|password|client[_-]?secret|cookie|set-cookie)$/i;
const SECRET_TEXT = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\bsk-[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9-]{36}$/;
export const digest = text => createHash('sha256').update(text).digest('hex');

function isValidStoredRecord(record, sessionId, id) {
  if (!record || record.schemaVersion !== 1 || record.sessionId !== sessionId || record.id !== id || !ID.test(id)) return false;
  if (typeof record.capturedAt !== 'string' || !Number.isFinite(Date.parse(record.capturedAt))) return false;
  const request = record.request;
  return request && typeof request === 'object' && !Array.isArray(request) && Array.isArray(request.messages) &&
    request.messages.every(hash => typeof hash === 'string' && HASH.test(hash)) &&
    ['systemRef', 'toolsRef', 'toolHistoryRef'].every(key => request[key] === undefined || (typeof request[key] === 'string' && HASH.test(request[key])));
}

// Best-effort masking of credentials embedded in content; NOT a general DLP promise.
// Schema objects under properties.apiKey are preserved (they describe a field, not a credential).
export function maskJson(value, key = '', stats = { count: 0 }) {
  if (SECRET_KEY.test(key) && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    stats.count++; return '[REDACTED]';
  }
  if (typeof value === 'string') {
    // Some adapters represent tool-call arguments as JSON text rather than an object.
    if (key === 'arguments') {
      try {
        const before = stats.count;
        const parsed = JSON.parse(value);
        const masked = maskJson(parsed, '', stats);
        if (stats.count > before) return JSON.stringify(masked);
      } catch { /* Non-JSON arguments are handled by the token-pattern masker below. */ }
    }
    return value.replace(SECRET_TEXT, () => { stats.count++; return '[REDACTED]'; });
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(item => maskJson(item, '', stats));
  if (typeof value === 'object') {
    const output = Object.create(null);
    for (const [name, item] of Object.entries(value)) {
      if (item !== undefined && typeof item !== 'function' && typeof item !== 'symbol') {
        output[name] = maskJson(item, name, stats);
      }
    }
    return output;
  }
  throw new Error('Request contains a non-JSON value');
}

export class ContextStore {
  constructor(root) {
    this.root = root;
    this.queue = Promise.resolve();
    this.cache = new WeakMap();
    this.frozenTrees = new WeakSet();
    this.written = new Set();
    this.errors = new Map();
    this.pending = new Map();
    this.index = new Map();
    this.indexLoads = new Map();
    this.analyticsChunks = new Map();
    this.analyticsChunkLoads = new Map();
    this.analyticsRecords = new Map();
    this.active = true;
    this.processId = randomUUID();
    this.captureOrder = 0;
    this.turnWrites = new Set();
    this.turns = new TurnTracker(id => readFile(join(this.sessionPath(id), 'turns.json'), 'utf8'), id => this.enqueueTurnWrite(id));
  }
  enqueueTurnWrite(sessionId) {
    if (!this.active || this.turnWrites.has(sessionId)) return;
    this.turnWrites.add(sessionId);
    const persist = async () => {
      const state = await this.turns.load(sessionId);
      if (!state.available) return;
      // One queued writer per session coalesces revisions produced while I/O awaits.
      let revision;
      do {
        revision = state.revision;
        const text = JSON.stringify(this.turns.payload(sessionId));
        await mkdir(this.sessionPath(sessionId), { recursive:true });
        const file = join(this.sessionPath(sessionId), 'turns.json');
        const temp = file + '.' + randomUUID() + '.tmp';
        await writeFile(temp, text, { flag:'wx', mode:0o600 });
        await rename(temp, file);
        state.persistedRevision = revision;
        if (state.problem === 'write') state.problem = null;
      } while (revision !== state.revision);
    };
    this.queue = this.queue.then(persist).catch(() => {
      this.turns.state(sessionId).problem = 'write';
    }).finally(() => {
      this.turnWrites.delete(sessionId);
      const state = this.turns.state(sessionId);
      if (state.available && state.problem !== 'write' && state.persistedRevision !== state.revision) this.enqueueTurnWrite(sessionId);
    });
  }
  syncSessionTurns(session, sessionId = session?.id) { return this.active ? this.turns.sync(session, sessionId) : null; }
  noteTurnFailure(sessionId) { if (this.active && typeof sessionId === 'string') this.turns.state(sessionId).problem = 'sync'; }
  turnBoundary(sessionId, inputEventCount) { return this.active ? this.turns.boundary(sessionId, inputEventCount) : {}; }
  sessionPath(id) { return join(this.root, 'sessions', digest(id)); }
  blobPath(hash) {
    if (!HASH.test(hash)) throw new Error('Invalid blob reference');
    return join(this.root, 'objects', hash.slice(0, 2), hash + '.json');
  }
  recordPath(sessionId, id) {
    if (!ID.test(id)) throw new Error('Invalid request identity');
    return join(this.sessionPath(sessionId), id + '.json');
  }
  chunk(value) {
    // A frozen Harness object may be shared across hundreds of calls.
    // Cache only recursively immutable trees (the caller passes the root-frozen flag separately).
    const stats = { count: 0 };
    const text = JSON.stringify(maskJson(value, '', stats));
    return { hash: digest(text), text, redactions: stats.count };
  }
  isDeepFrozen(value, visiting = new WeakSet()) {
    if (!value || typeof value !== 'object') return true;
    if (this.frozenTrees.has(value)) return true;
    if (!Object.isFrozen(value) || visiting.has(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
    if (descriptors.some(descriptor => !('value' in descriptor) || typeof descriptor.value === 'function')) return false;
    visiting.add(value);
    const yes = descriptors.every(descriptor => this.isDeepFrozen(descriptor.value, visiting));
    visiting.delete(value);
    if (yes) this.frozenTrees.add(value);
    return yes;
  }
  cachedChunk(value) {
    if (value && typeof value === 'object' && this.isDeepFrozen(value)) {
      const previous = this.cache.get(value);
      if (previous) return previous;
      const chunk = this.chunk(value);
      this.cache.set(value, chunk);
      return chunk;
    }
    return this.chunk(value);
  }
  analyticsKey(hash, kind) { return hash + '/' + kind; }
  summarizeAnalyticsChunk(hash, kind, value) {
    const key = this.analyticsKey(hash, kind);
    if (!this.analyticsChunks.has(key)) this.analyticsChunks.set(key, summarizeChunk(value, kind));
    return this.analyticsChunks.get(key);
  }
  async loadAnalyticsChunk(hash, kind) {
    const key = this.analyticsKey(hash, kind);
    if (this.analyticsChunks.has(key)) return this.analyticsChunks.get(key);
    if (this.analyticsChunkLoads.has(key)) return this.analyticsChunkLoads.get(key);
    const loading = this.readBlob(hash).then(value => this.summarizeAnalyticsChunk(hash, kind, value));
    this.analyticsChunkLoads.set(key, loading);
    try { return await loading; }
    finally { this.analyticsChunkLoads.delete(key); }
  }
  async ensureAnalytics(record) {
    if (isValidAnalytics(record.analytics) && record.analytics.messageCount === record.request.messages.length) return record.analytics;
    if (record.analyticsUnavailable) return undefined;
    delete record.analytics;
    const key = record.sessionId + '/' + record.id;
    if (!this.analyticsRecords.has(key)) {
      const loading = (async () => {
        const refs = record.request;
        const needed = [...new Set(refs.messages)].map(hash => [hash, 'message']);
        for (const kind of ['system', 'tools', 'toolHistory']) if (refs[kind + 'Ref'] !== undefined) needed.push([refs[kind + 'Ref'], kind]);
        for (let offset = 0; offset < needed.length; offset += 16) {
          await Promise.all(needed.slice(offset, offset + 16).map(([hash, kind]) => this.loadAnalyticsChunk(hash, kind)));
        }
        return estimateAnalytics(refs, (hash, kind) => this.analyticsChunks.get(this.analyticsKey(hash, kind)));
      })();
      this.analyticsRecords.set(key, loading);
      loading.catch(() => this.analyticsRecords.delete(key));
    }
    // Backfill old schemaVersion:1 records only in memory, never rewrite their bytes.
    record.analytics = await this.analyticsRecords.get(key);
    delete record.analyticsUnavailable;
    this.errors.delete(key);
    const indexed = this.index.get(record.sessionId)?.get(record.id);
    if (indexed) {
      indexed.analytics = record.analytics;
      delete indexed.analyticsUnavailable;
    }
    return record.analytics;
  }
  capture(options, boundary = {}) {
    if (!this.active || typeof options.sessionId !== 'string') return undefined;
    if (!Array.isArray(options.messages)) throw new Error('Missing assembled messages');
    const chunks = new Map();
    let redactions = 0;
    // Core loop messages are recursively frozen and cached by identity.
    // Handwritten or shallow-frozen input is safely copied synchronously.
    const add = value => {
      const chunk = this.cachedChunk(value);
      chunks.set(chunk.hash, chunk);
      redactions += chunk.redactions;
      return chunk.hash;
    };
    const fields = {};
    for (const key of REQUEST_KEYS) if (options[key] !== undefined) fields[key] = options[key];
    // These are the actual arguments observed at llm/stream, not synthesized roles.
    const request = { ...fields, messages: options.messages.map(add) };
    for (const key of ['system', 'tools', 'toolHistory']) if (options[key] !== undefined) request[key + 'Ref'] = add(options[key]);
    const fieldStats = { count:0 };
    const safeFields = maskJson(request, '', fieldStats);
    redactions += fieldStats.count;
    const record = {
      schemaVersion: 1, id: randomUUID(), capturedAt: new Date().toISOString(),
      processId: this.processId, captureOrder: ++this.captureOrder,
      source: 'llm/stream', boundary: 'harness-before-adapter',
      sessionId: options.sessionId, purpose: options.purpose ?? 'assistant',
      inputEventCount: boundary.inputEventCount ?? null,
      turn: boundary.turn ?? null, step: boundary.step ?? null,
      turnStartSeq: boundary.turnStartSeq ?? null, turnIndexId: boundary.turnIndexId ?? null,
      turnAssociationVerified: typeof boundary.turnAssociationVerified === 'boolean' ? boundary.turnAssociationVerified : null,
      request: safeFields, messageCount: options.messages.length,
      toolCount: options.tools?.length ?? 0,
      redactions,
      analytics: estimateAnalytics(safeFields, (hash, kind) => {
        const key = this.analyticsKey(hash, kind);
        if (this.analyticsChunks.has(key)) return this.analyticsChunks.get(key);
        // Parse the masked CAS copy, never estimate or retain unredacted inputs.
        return this.summarizeAnalyticsChunk(hash, kind, JSON.parse(chunks.get(hash).text));
      }),
      omittedFields: Object.keys(options).filter(key => !REQUEST_KEYS.includes(key) && !['messages', 'system', 'tools', 'toolHistory'].includes(key)),
    };
    const pendingKey = record.sessionId + '/' + record.id;
    this.pending.set(pendingKey, record);
    const persist = async () => {
      for (const chunk of chunks.values()) {
        if (this.written.has(chunk.hash)) continue;
        const file = this.blobPath(chunk.hash);
        await mkdir(join(this.root, 'objects', chunk.hash.slice(0, 2)), { recursive: true });
        // Verify existing blobs. Publish newly written bytes atomically: a crash
        // must never leave a half-written final object that EEXIST would hide.
        let exists = false;
        try {
          const existing = await readFile(file, 'utf8');
          if (digest(existing) !== chunk.hash) throw Object.assign(new Error('Corrupt object'), { code:'STORE_CORRUPT' });
          exists = true;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!exists) {
          const tempObject = file + '.' + randomUUID() + '.tmp';
          await writeFile(tempObject, chunk.text, { flag:'wx', mode:0o600 });
          await rename(tempObject, file);
        }
        this.written.add(chunk.hash);
      }
      await mkdir(this.sessionPath(record.sessionId), { recursive: true });
      const file = this.recordPath(record.sessionId, record.id);
      const temp = file + '.tmp';
      await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
      await rename(temp, file);
      this.index.get(record.sessionId)?.set(record.id, record);
      this.errors.delete(pendingKey);
      this.pending.delete(pendingKey);
    };
    // Capturing never waits on I/O and never modifies or consumes the model stream.
    this.queue = this.queue.then(persist).catch(error => {
      this.errors.set(pendingKey, String(error.code ?? 'STORE_WRITE_FAILED'));
      // Do not log prompt text, endpoints with credentials, or error payloads.
      console.warn('[request-context] local snapshot write failed:', error.code ?? 'STORE_WRITE_FAILED');
    });
    return record.id;
  }
  captureFailure(sessionId, code = 'CAPTURE_FAILED') {
    if (typeof sessionId === 'string') this.errors.set(sessionId + '/' + randomUUID(), code);
  }
  async flush() {
    let queued;
    do { queued = this.queue; await queued; } while (queued !== this.queue);
  }
  async loadIndex(sessionId) {
    if (this.indexLoads.has(sessionId)) return this.indexLoads.get(sessionId);
    const index = new Map();
    this.index.set(sessionId, index);
    const loading = (async () => {
      let files;
      try { files = await readdir(this.sessionPath(sessionId)); }
      catch (error) { if (error.code === 'ENOENT') files = []; else throw error; }
      for (const file of files) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
        const id = file.slice(0, -5);
        try {
          const record = JSON.parse(await readFile(join(this.sessionPath(sessionId), file), 'utf8'));
          if (!isValidStoredRecord(record, sessionId, id)) throw new Error('Invalid stored request');
          index.set(record.id, record);
        } catch {
          // Isolate damaged metadata without logging prompt bytes or exception text.
          this.errors.set(sessionId + '/' + id, 'SNAPSHOT_READ_FAILED');
        }
      }
      return index;
    })();
    this.indexLoads.set(sessionId, loading);
    try { return await loading; }
    catch (error) { this.indexLoads.delete(sessionId); throw error; }
  }
  async list(sessionId) {
    await this.turns.load(sessionId);
    await this.flush();
    const records = [...(await this.loadIndex(sessionId)).values()];
    // Persisted analytics require no CAS reads during polling. Legacy snapshots
    // load referenced bodies once, with shared hash summaries and record caching.
    for (let offset = 0; offset < records.length; offset += 16) {
      await Promise.all(records.slice(offset, offset + 16).map(async record => {
        try { await this.ensureAnalytics(record); }
        catch {
          delete record.analytics;
          record.analyticsUnavailable = true;
          this.errors.set(sessionId + '/' + record.id, 'ANALYTICS_UNAVAILABLE');
        }
      }));
    }
    records.sort((a, b) => compareCaptures(b, a));
    const { infos, rounds } = this.turns.project(sessionId, records);
    return {
      rounds,
      records: records.map(({ request, ...meta }) => ({ ...meta, turnInfo:infos.get(meta.id) ?? null, provider: request.provider, model: request.model })),
      failures: [...this.errors].filter(([key]) => key.startsWith(sessionId + '/')).map(([key, code]) => ({ id: key.slice(sessionId.length + 1), code })),
      notice: '仅包含插件启用后、有 sessionId 且经过 llm/stream 的会话模型调用；供应商内部 HTTP 重试不单独记录。安装前的历史没有精确快照。',
    };
  }
  async readBlob(hash) {
    const text = await readFile(this.blobPath(hash), 'utf8');
    if (digest(text) !== hash) throw new Error('Snapshot object integrity check failed');
    return JSON.parse(text);
  }
  async get(sessionId, id) {
    await this.turns.load(sessionId);
    await this.flush();
    const record = JSON.parse(await readFile(this.recordPath(sessionId, id), 'utf8'));
    if (!isValidStoredRecord(record, sessionId, id)) throw new Error('Invalid stored request');
    const { messages, systemRef, toolsRef, toolHistoryRef, ...config } = record.request;
    const fullMessages = [];
    // Bound filesystem concurrency while retaining original order, including duplicates.
    for (let offset = 0; offset < messages.length; offset += 16) {
      fullMessages.push(...await Promise.all(messages.slice(offset, offset + 16).map(hash => this.readBlob(hash))));
    }
    const request = { ...config, messages: fullMessages };
    for (let index = 0; index < messages.length; index++) this.summarizeAnalyticsChunk(messages[index], 'message', fullMessages[index]);
    for (const [key, hash] of [['system', systemRef], ['tools', toolsRef], ['toolHistory', toolHistoryRef]]) {
      if (hash !== undefined) {
        request[key] = await this.readBlob(hash);
        this.summarizeAnalyticsChunk(hash, key, request[key]);
      }
    }
    await this.ensureAnalytics(record);
    const { request: refs, ...meta } = record;
    meta.turnInfo = null;
    try {
      const indexed = [...(await this.loadIndex(sessionId)).values()];
      if (!indexed.some(value => value.id === id)) indexed.push(record);
      meta.turnInfo = this.turns.project(sessionId, indexed).infos.get(id) ?? null;
    } catch { this.noteTurnFailure(sessionId); }
    return {
      meta, request,
      notes: [
        '这是 llm/stream 观察点的完整逻辑输入（已脱敏），不是供应商最终 HTTP JSON。后续 middleware 与适配器还可能转换它。',
        'messages 的角色、顺序、source 和内容块保持原结构；system 字段仅在调用本来提供该字段时出现。',
        '图片/文件保留 Harness 附件引用，不读取或复制附件字节。认证凭据、HTTP headers、AbortSignal 不在允许保存的字段中。',
        'analytics 是已脱敏逻辑输入的启发式估算：ASCII 约 4 字符/token，非 ASCII 按 Unicode 码点约 1 字符/token，每条消息另计 4 framing tokens；不是供应商精确 token 或计费数据。',
        '分类 token 互斥且总和等于估算总量；各类 messageCount 表示含该类贡献的消息数，同一条含正文和工具调用的消息可跨类计数，但总 messageCount 不重复。独立 system 与 tools 字段不增加消息数。',
        'reasoning 按所在类别计入，但适配器可能移除；图片/文件只计附件数量，不估造视觉 token；未知内容块保守按 compact JSON 估算。toolHistoryTokens 仅作诊断，不纳入总量以免与有效 tools 重复。',
        '内容中的常见密钥格式会尽力脱敏，但不能保证识别用户文本内的所有秘密；快照明文存储在本机，请勿公开分享。',
      ],
    };
  }
  async dispose() {
    this.active = false;
    await this.flush();
    this.cache = new WeakMap();
    this.written.clear();
    this.pending.clear();
    this.analyticsChunks.clear();
    this.analyticsChunkLoads.clear();
    this.analyticsRecords.clear();
    this.turns.states.clear();
    this.turns.loads.clear();
    this.turnWrites.clear();
  }
}
