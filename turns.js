import { createHash, randomUUID } from 'node:crypto';

const TYPES = new Set(['turn/start', 'turn/end', 'step/start', 'step/end']);
const END_KINDS = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked', 'unknown']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const LIMIT_NOTICE = '只统计本插件捕获的 llm/stream 请求；启用前、禁用期间或丢失记录可能使每轮次数不完整。标题/压缩等辅助请求不计主请求均值，同一步的重试按每次捕获分别计数。';
export const isTurnBoundary = event => TYPES.has(event?.type);

// Never retain message payloads, exception objects, reason.reason or failure text.
export function pickTurnEvent(event) {
  if (!isTurnBoundary(event)) return null;
  if (!integer(event.seq) || !integer(event.data?.turn)) throw new Error('Invalid turn event');
  const data = { turn:event.data.turn };
  if (event.type.startsWith('step/')) {
    if (!integer(event.data.step)) throw new Error('Invalid step event');
    data.step = event.data.step;
  }
  if (event.type === 'turn/end') data.reason = { kind:END_KINDS.has(event.data.reason?.kind) ? event.data.reason.kind : 'unknown' };
  return { seq:event.seq, time:typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : null, type:event.type, data };
}

export function validTurnSidecar(value, sessionId) {
  if (!value || value.version !== 1 || value.source !== 'session-events' || value.sessionId !== sessionId || !integer(value.cursor) || typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity)) return false;
  if (!Array.isArray(value.generations) || !value.generations.length || !value.generations.every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) || typeof value.legacyAllowed !== 'boolean' || !Array.isArray(value.events)) return false;
  let previous = -1;
  try {
    for (const event of value.events) {
      if (!isTurnBoundary(event) || event.seq <= previous || event.seq >= value.cursor || JSON.stringify(pickTurnEvent(event)) !== JSON.stringify(event)) return false;
      previous = event.seq;
    }
  } catch { return false; }
  return true;
}

// A prefix contains events with seq < inputEventCount, never the event at that seq.
export function foldTurns(events) {
  const turns = [];
  const transitions = [];
  let active = null, step = null, reliable = true;
  for (const event of events) {
    const { type, data, seq, time } = event;
    if (type === 'turn/start') {
      if (active) { active.status = 'unknown'; reliable = false; }
      active = { key:`turn:${seq}`, turn:data.turn, startSeq:seq, endSeq:null, startedAt:time, endedAt:null, status:'running', mainCallCount:0, auxiliaryCallCount:0, firstRequestId:null, lastRequestId:null };
      turns.push(active); step = null;
    } else if (type === 'turn/end') {
      if (!active || active.turn !== data.turn) reliable = false;
      else { active.endSeq = seq; active.endedAt = time; active.status = data.reason.kind; active = null; step = null; }
    } else if (type === 'step/start') {
      if (!active || active.turn !== data.turn || step !== null) reliable = false;
      else step = data.step;
    } else if (type === 'step/end') {
      if (!active || active.turn !== data.turn || step !== data.step) reliable = false;
      else step = null;
    }
    transitions.push({ seq, activeKey:active?.key ?? null, step });
  }
  return { turns, transitions, activeKey:active?.key ?? null, reliable };
}

function atPrefix(folded, prefix) {
  let lo = 0, hi = folded.transitions.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (folded.transitions[mid].seq < prefix) lo = mid + 1; else hi = mid; }
  return lo ? folded.transitions[lo - 1] : null;
}

export function compareCaptures(a, b) {
  return a.capturedAt.localeCompare(b.capturedAt) ||
    (a.processId === b.processId && Number.isSafeInteger(a.captureOrder) && Number.isSafeInteger(b.captureOrder) ? a.captureOrder - b.captureOrder : a.id.localeCompare(b.id));
}

export function projectTurnRecords(state, records) {
  const folded = state?.available ? foldTurns(state.events) : null;
  const available = Boolean(folded?.reliable);
  const turns = available ? folded.turns : [];
  const byKey = new Map(turns.map(turn => [turn.key, turn]));
  const infos = new Map();
  let unassignedMainCallCount = 0;
  for (const record of [...records].sort(compareCaptures)) {
    const main = (record.purpose ?? 'assistant') === 'assistant';
    const prefix = record.inputEventCount;
    const allowedGeneration = record.turnIndexId ? state?.generations?.includes(record.turnIndexId) : state?.legacyAllowed;
    const transition = record.turnAssociationVerified !== false && available && allowedGeneration && integer(prefix) && prefix <= state.cursor ? atPrefix(folded, prefix) : null;
    const turn = transition?.activeKey ? byKey.get(transition.activeKey) : null;
    if (!turn || (record.turnStartSeq != null && record.turnStartSeq !== turn.startSeq)) {
      infos.set(record.id, null); if (main) unassignedMainCallCount++; continue;
    }
    if (main) {
      turn.mainCallCount++;
      turn.firstRequestId ??= record.id;
      turn.lastRequestId = record.id;
    } else turn.auxiliaryCallCount++;
    infos.set(record.id, { key:turn.key, turn:turn.turn, startSeq:turn.startSeq, step:transition.step, callInTurn:main ? turn.mainCallCount : null, status:turn.status, source:'session-events' });
  }
  const completed = turns.filter(turn => turn.status === 'completed' && turn.mainCallCount > 0);
  const completedCallCount = completed.reduce((sum, turn) => sum + turn.mainCallCount, 0);
  const current = available ? byKey.get(folded.activeKey) : null;
  const notices = [LIMIT_NOTICE];
  if (!available) notices.push(state?.problem === 'corrupt' ? '轮次索引损坏且没有可用 live 日志；轮次未知。' : '没有可用且一致的公开轮次日志；轮次未知，不按时间或消息数量猜测。');
  if (state?.reset) notices.push('检测到日志身份变化或 seq 回退；旧日志关联已隔离，无法验证的旧请求不分配轮次。');
  if (state?.problem === 'write') notices.push('轮次索引持久化失败；当前内存统计可用，但重启后可能缺失。');
  if (state?.problem === 'sync') notices.push('轮次日志同步失败；仅显示最后已知边界，不断言实时状态。');
  if (current && !state.live) notices.push('这是持久索引的最后已知状态：末尾未观察到结束事件，不代表该轮现在仍在运行。');
  return { infos, rounds:{ version:1, source:'session-events', available, turns, completedTurnCount:completed.length, completedCallCount, averageCompletedCalls:completed.length ? completedCallCount / completed.length : null, currentTurnKey:current?.key ?? null, currentTurn:current?.turn ?? null, currentCallCount:current?.mainCallCount ?? null, unassignedMainCallCount, notice:notices.join(' ') } };
}

function sessionIdentity(session, id) {
  const header = session.header;
  return hash({ id, createdAt:Number.isFinite(header?.createdAt) ? header.createdAt : null, parentSession:typeof header?.parentSession === 'string' ? header.parentSession : null, isSeeded:header?.isSeeded === true, inheritedEventCount:integer(session.inheritedEventCount) ? session.inheritedEventCount : null });
}
const prefixEvents = (events, cursor) => events.filter(event => event.seq < cursor);
const samePrefix = (left, right, cursor) => JSON.stringify(prefixEvents(left, cursor)) === JSON.stringify(prefixEvents(right, cursor));

// Sync methods do no filesystem I/O. read/publish are called only by the Host queue/API.
export class TurnTracker {
  constructor(read, schedule) { this.read = read; this.schedule = schedule; this.states = new Map(); this.loads = new Map(); }
  state(id) {
    if (!this.states.has(id)) this.states.set(id, { sessionId:id, available:false, events:[], cursor:0, identity:null, generations:[randomUUID()], legacyAllowed:true, revision:0, diskLoaded:false, live:false, liveSession:null, reset:false, problem:null });
    return this.states.get(id);
  }
  async load(id) {
    const state = this.state(id);
    if (state.diskLoaded) return state;
    if (this.loads.has(id)) return this.loads.get(id);
    const loading = (async () => {
      let saved;
      try {
        saved = JSON.parse(await this.read(id));
        if (!validTurnSidecar(saved, id)) throw new Error('Invalid turn index');
      } catch (error) { if (error.code !== 'ENOENT') state.problem ??= 'corrupt'; }
      state.diskLoaded = true;
      if (!saved || !validTurnSidecar(saved, id)) return state;
      if (!state.available) {
        Object.assign(state, { available:true, events:saved.events, cursor:saved.cursor, identity:saved.identity, generations:saved.generations, legacyAllowed:saved.legacyAllowed, reset:!saved.legacyAllowed, problem:null });
      } else if (!state.reset && saved.identity === state.identity && state.cursor >= saved.cursor && samePrefix(saved.events, state.events, saved.cursor)) {
        // The live provisional generation is retained for requests captured before async load.
        state.generations = [...new Set([...state.generations, ...saved.generations])];
        state.legacyAllowed = state.legacyAllowed && saved.legacyAllowed;
        state.reset ||= !saved.legacyAllowed;
        state.revision++;
      } else {
        // Never attach older captured requests to a replacement/truncated live log.
        state.legacyAllowed = false; state.reset = true; state.revision++;
      }
      return state;
    })();
    this.loads.set(id, loading);
    try { return await loading; } finally { this.loads.delete(id); }
  }
  changed(state) { state.revision++; this.schedule(state.sessionId); }
  sync(session, requestedId = session?.id) {
    if (typeof requestedId !== 'string') return null;
    const state = this.state(requestedId);
    try {
      if (!session || typeof session.snapshotEvents !== 'function' || !integer(session.seq)) { state.live = false; return state; }
      if (typeof session.id === 'string' && session.id !== requestedId) throw new Error('Wrong session identity');
      const identity = sessionIdentity(session, requestedId), cursor = session.seq;
      const rescan = !state.available || state.liveSession !== session || cursor < state.cursor || identity !== state.identity;
      const from = rescan ? 0 : state.cursor;
      const raw = session.snapshotEvents(from, cursor);
      if (!Array.isArray(raw)) throw new Error('Invalid event snapshot');
      const additions = [];
      let previous = from - 1;
      for (const event of raw) {
        if (!integer(event?.seq) || event.seq < from || event.seq >= cursor || event.seq <= previous) throw new Error('Invalid event sequence');
        previous = event.seq;
        const safe = pickTurnEvent(event); if (safe) additions.push(safe);
      }
      // Full snapshots must actually cover the stated half-open event prefix.
      if (raw.length !== cursor - from) throw new Error('Incomplete event snapshot');
      if (rescan && state.available && (identity !== state.identity || cursor < state.cursor || !samePrefix(state.events, additions, state.cursor))) {
        state.generations = [randomUUID()]; state.legacyAllowed = false; state.reset = true;
      }
      const changed = !state.available || state.cursor !== cursor || state.identity !== identity || rescan && JSON.stringify(state.events) !== JSON.stringify(additions);
      if (rescan) state.events = additions; else state.events.push(...additions);
      Object.assign(state, { available:true, cursor, identity, live:true, liveSession:session, problem:state.problem === 'write' ? 'write' : null });
      if (changed) this.changed(state);
      return state;
    } catch {
      state.problem = 'sync'; state.live = false;
      // Retain the prior safe index, but never advance its cursor on a failed read.
      return state;
    }
  }
  boundary(id, inputEventCount) {
    const state = this.state(id);
    if (!state.available || !state.live || state.problem === 'sync' || !integer(inputEventCount) || inputEventCount > state.cursor) return { turnAssociationVerified:false };
    const folded = foldTurns(state.events);
    if (!folded.reliable) return { turnAssociationVerified:false };
    const transition = atPrefix(folded, inputEventCount);
    const turn = folded.turns.find(row => row.key === transition?.activeKey);
    const verified = { turnAssociationVerified:true, turnIndexId:state.generations[0] };
    return turn ? { ...verified, turn:turn.turn, step:transition.step, turnStartSeq:turn.startSeq } : verified;
  }
  payload(id) {
    const state = this.state(id);
    return { version:1, source:'session-events', sessionId:id, cursor:state.cursor, identity:state.identity, generations:[...state.generations], legacyAllowed:state.legacyAllowed, events:state.events.map(event => pickTurnEvent(event)) };
  }
  project(id, records) { return projectTurnRecords(this.states.get(id), records); }
}
