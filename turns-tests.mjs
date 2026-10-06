import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ContextStore } from './store.js';
import { pickTurnEvent, projectTurnRecords, validTurnSidecar } from './turns.js';
import { apply, ROUTE } from './index.js';

const root = resolve(import.meta.dirname, '.test-state');
await mkdir(root, { recursive:true });
const fresh = async () => new ContextStore(await mkdtemp(join(root, 'turns-')));
class Session {
  constructor(id = 'turn-test', header = { createdAt:123 }) { this.id = id; this.header = header; this.events = []; this.reads = []; }
  get seq() { return this.events.length; }
  snapshotEvents(from = 0, end = this.seq) { this.reads.push([from,end]); return this.events.slice(from,end); }
  eventAt(seq) { return this.events[seq]; }
  append(type, data, time = 1000 + this.seq) { const event = { seq:this.seq, time, type, data }; this.events.push(event); return event; }
  start(turn, step = 1) { this.append('turn/start',{turn}); this.append('step/start',{turn,step}); }
  end(turn, step = 1, kind = 'completed') { this.append('step/end',{turn,step}); return this.append('turn/end',{turn,reason:{kind}}); }
}
const options = (sessionId = 'turn-test', purpose) => ({ provider:'test', model:'test', sessionId, messages:[{ role:'user', content:[{type:'text',text:'test fixture only'}] }], ...(purpose ? {purpose} : {}) });
function capture(store, session, purpose) {
  store.syncSessionTurns(session);
  return store.capture(options(session.id,purpose), { inputEventCount:session.seq, ...store.turnBoundary(session.id,session.seq) });
}
const file = (store, sessionId = 'turn-test') => join(store.sessionPath(sessionId),'turns.json');
const plainRecord = (id,prefix,purpose = 'assistant') => ({ id, capturedAt:'2026-01-01T00:00:00.000Z', processId:'p', captureOrder:Number(id), inputEventCount:prefix, purpose });

test('half-open event prefixes map starts and ends exactly, and step/end clears only the step', () => {
  const session = new Session(); session.start(1); session.append('user/message',{text:'not saved'}); session.end(1);
  const state = { available:true, events:session.events.map(pickTurnEvent).filter(Boolean), cursor:session.seq, generations:[], legacyAllowed:true, live:true };
  const records = Array.from({length:6},(_,prefix) => plainRecord(String(prefix),prefix));
  const {infos,rounds} = projectTurnRecords(state,records);
  assert.equal(infos.get('0'),null);
  assert.equal(infos.get('1').step,null);
  assert.equal(infos.get('2').step,1);
  assert.equal(infos.get('3').step,1);
  assert.equal(infos.get('4').step,null); // turn/end at seq 4 is not yet in prefix 4
  assert.equal(infos.get('5'),null);
  assert.equal(infos.get('2').status,'completed');
  assert.equal(rounds.turns[0].startSeq,0);
  assert.equal(rounds.turns[0].endSeq,4);
  assert.equal(rounds.unassignedMainCallCount,2);
});

test('two successful turns average captured main calls only, running turn and auxiliaries excluded', async () => {
  const store = await fresh(); const session = new Session();
  session.start(1);
  const first = capture(store,session); const retry = capture(store,session);
  const title = capture(store,session,'session-title');
  session.end(1);
  session.start(2);
  for (let index=0; index<3; index++) capture(store,session);
  capture(store,session,'compaction'); session.end(2);
  session.start(3); const current = capture(store,session);
  const listing = await store.list(session.id);
  assert.equal(listing.rounds.available,true);
  assert.equal(listing.rounds.completedTurnCount,2);
  assert.equal(listing.rounds.completedCallCount,5);
  assert.equal(listing.rounds.averageCompletedCalls,2.5);
  assert.equal(listing.rounds.currentTurn,3);
  assert.equal(listing.rounds.currentCallCount,1);
  assert.deepEqual(listing.rounds.turns.map(row => [row.mainCallCount,row.auxiliaryCallCount]),[[2,1],[3,1],[1,0]]);
  assert.equal(listing.records.find(row => row.id === retry).turnInfo.callInTurn,2);
  assert.equal(listing.records.find(row => row.id === first).turnInfo.step,1);
  assert.equal(listing.records.find(row => row.id === title).turnInfo.callInTurn,null);
  assert.equal(listing.rounds.turns[0].firstRequestId,first);
  assert.equal(listing.rounds.turns[0].lastRequestId,retry);
  assert.equal(listing.records[0].id,current);
  assert.equal((await store.get(session.id,retry)).meta.turnInfo.callInTurn,2);
  await store.dispose();
});

test('all closure reasons are retained, but only completed turns with captured main requests enter average', async () => {
  const store = await fresh(); const session = new Session();
  const kinds = ['aborted','blocked','error','max-tokens','interrupted','forked','completed'];
  for (const [index,kind] of kinds.entries()) { session.start(index+1); capture(store,session); session.end(index+1,1,kind); }
  session.start(8); capture(store,session,'session-title'); session.end(8);
  session.start(9); // open turn with zero captured calls is still known
  store.syncSessionTurns(session);
  const {rounds} = await store.list(session.id);
  assert.deepEqual(rounds.turns.map(row => row.status),[...kinds,'completed','running']);
  assert.equal(rounds.completedTurnCount,1); assert.equal(rounds.averageCompletedCalls,1);
  assert.equal(rounds.currentCallCount,0);
  await store.dispose();
});

test('incremental synchronization scans only new events and sidecar saves only whitelisted boundary data', async () => {
  const store = await fresh(); const session = new Session();
  session.append('user/message',{text:'PRIVATE_MESSAGE_BODY'});
  session.start(1); const id = capture(store,session);
  session.append('assistant/message',{message:{content:'PRIVATE_ASSISTANT_BODY'},usage:{inputTokens:999}});
  session.append('step/end',{turn:1,step:1,secret:'PRIVATE_STEP_EXTRA'});
  session.append('turn/end',{turn:1,reason:{kind:'error',error:{message:'PRIVATE_FAILURE'},reason:'PRIVATE_REASON'},other:'PRIVATE_EXTRA'});
  store.syncSessionTurns(session); store.syncSessionTurns(session);
  await store.flush();
  assert.deepEqual(session.reads,[[0,3],[3,6],[6,6]]);
  const text = await readFile(file(store),'utf8');
  assert.ok(!text.includes('PRIVATE_')); assert.ok(!text.includes('assistant/message'));
  const saved = JSON.parse(text); assert.ok(validTurnSidecar(saved,session.id));
  assert.deepEqual(Object.keys(saved.events[0]),['seq','time','type','data']);
  assert.deepEqual(saved.events.at(-1).data,{turn:1,reason:{kind:'error'}});
  assert.equal((await store.get(session.id,id)).meta.turnInfo.status,'error');
  await store.dispose();
});

test('legacy null boundaries backfill from inputEventCount without rewriting original record bytes', async () => {
  const store = await fresh(); const session = new Session(); session.start(1);
  const id = store.capture(options(),{inputEventCount:session.seq});
  await store.flush(); const before = await readFile(store.recordPath(session.id,id),'utf8');
  const original = JSON.parse(before); assert.equal(original.turn,null); assert.equal(original.step,null);
  assert.equal((await store.list(session.id)).records[0].turnInfo,null);
  store.syncSessionTurns(session);
  assert.equal((await store.list(session.id)).records[0].turnInfo.turn,1);
  assert.equal((await store.get(session.id,id)).meta.turnInfo.step,1);
  assert.equal(await readFile(store.recordPath(session.id,id),'utf8'),before);
  await store.dispose();
});

test('restart without live session preserves completed and last-known open states with an explicit notice', async () => {
  const store = await fresh(); const session = new Session(); session.start(1); capture(store,session); session.end(1); session.start(2); const id = capture(store,session);
  await store.flush(); const restarted = new ContextStore(store.root);
  const listing = await restarted.list(session.id);
  assert.equal(listing.rounds.completedTurnCount,1);
  assert.equal(listing.rounds.currentTurn,2);
  assert.match(listing.rounds.notice,/末尾未观察到结束事件/);
  assert.equal((await restarted.get(session.id,id)).meta.turnInfo.status,'running');
  await store.dispose(); await restarted.dispose();
});

test('live restore before sidecar async load reconciles only the same boundary prefix', async () => {
  const store = await fresh(); const session = new Session(); session.start(1); const old = capture(store,session); await store.flush();
  const restarted = new ContextStore(store.root);
  const restore = new Session(); restore.events = [...session.events];
  const freshId = capture(restarted,restore); restore.end(1); restarted.syncSessionTurns(restore);
  const listing = await restarted.list(restore.id);
  assert.equal(listing.rounds.completedCallCount,2);
  assert.deepEqual(new Set(listing.records.map(row => row.id)),new Set([old,freshId]));
  assert.ok(listing.records.every(row => row.turnInfo?.status === 'completed'));
  await store.dispose(); await restarted.dispose();
});

test('missing logs, out-of-range prefixes and seq-only mocks never guess turn from timestamp or stored turn number', async () => {
  const store = await fresh();
  const id = store.capture(options(),{inputEventCount:20,turn:99,step:88});
  store.syncSessionTurns({id:'turn-test',seq:20});
  const unknown = await store.list('turn-test');
  assert.equal(unknown.rounds.available,false); assert.equal(unknown.rounds.currentCallCount,null);
  assert.equal(unknown.rounds.averageCompletedCalls,null); assert.equal(unknown.rounds.unassignedMainCallCount,1);
  assert.equal(unknown.records[0].turnInfo,null);
  assert.equal((await store.get('turn-test',id)).meta.turn,99);
  const session = new Session(); session.start(1); store.syncSessionTurns(session);
  assert.equal((await store.list(session.id)).records[0].turnInfo,null);
  await store.dispose();
});

test('corrupt and foreign sidecars degrade independently; valid snapshots remain readable', async () => {
  const store = await fresh(); const id = store.capture(options(),{inputEventCount:1}); await store.flush();
  await writeFile(file(store),'broken json');
  const restarted = new ContextStore(store.root);
  const listing = await restarted.list('turn-test');
  assert.equal(listing.rounds.available,false); assert.match(listing.rounds.notice,/损坏/);
  assert.equal((await restarted.get('turn-test',id)).request.messages.length,1);
  const healthy = new Session(); healthy.start(1); store.syncSessionTurns(healthy); await store.flush();
  const saved = JSON.parse(await readFile(file(store),'utf8')); saved.sessionId = 'foreign';
  assert.equal(validTurnSidecar(saved,'turn-test'),false);
  saved.sessionId = 'turn-test'; saved.events[0].data.private = 'should reject';
  assert.equal(validTurnSidecar(saved,'turn-test'),false);
  await store.dispose(); await restarted.dispose();
});

test('seq rollback and same-id replacement isolate old records instead of attaching them to new turns', async () => {
  const store = await fresh(); const session = new Session(); session.start(1); const old = capture(store,session); await store.flush();
  const replacement = new Session('turn-test',{createdAt:456}); replacement.start(8);
  const freshId = capture(store,replacement);
  const listing = await store.list(replacement.id);
  assert.equal(listing.records.find(row => row.id === old).turnInfo,null);
  assert.equal(listing.records.find(row => row.id === freshId).turnInfo.turn,8);
  assert.equal(listing.rounds.unassignedMainCallCount,1); assert.match(listing.rounds.notice,/隔离/);
  replacement.events.length = 0; store.syncSessionTurns(replacement); replacement.start(9);
  const afterRollback = capture(store,replacement);
  const rolled = await store.list(replacement.id);
  assert.equal(rolled.records.find(row => row.id === freshId).turnInfo,null);
  assert.equal(rolled.records.find(row => row.id === afterRollback).turnInfo.turn,9);
  assert.equal(rolled.rounds.unassignedMainCallCount,2);
  await store.dispose();
});

test('forked sessions are isolated by id and inherited public fork closers do not count as completed', async () => {
  const store = await fresh(); const parent = new Session('parent'); parent.start(1); capture(store,parent);
  const child = new Session('child',{createdAt:124,parentSession:'parent',isSeeded:true}); child.inheritedEventCount = parent.seq; child.events = [...parent.events]; child.end(1,1,'forked'); child.start(2); capture(store,child);
  store.syncSessionTurns(parent); store.syncSessionTurns(child);
  const a = await store.list('parent'), b = await store.list('child');
  assert.equal(a.rounds.currentTurn,1); assert.equal(a.rounds.currentCallCount,1);
  assert.equal(b.rounds.currentTurn,2); assert.equal(b.rounds.completedTurnCount,0);
  assert.equal(b.rounds.turns[0].status,'forked'); assert.equal(b.rounds.turns[0].mainCallCount,0);
  assert.equal(a.records.length,1); assert.equal(b.records.length,1);
  await store.dispose();
});

function host(store, sessionRef) {
  const hooks = new Map(), disposers = []; let route;
  const ctx = { sessions:{get:() => sessionRef.value}, on:(name,fn) => hooks.set(name,fn), effect:fn => {const dispose = fn(); disposers.push(dispose); return dispose;}, connection:{fetch:{register:value => {route = value; return ()=>{};}}} };
  apply(ctx,{dataDir:store.root});
  return {hooks,get route(){return route;},async close(){ for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose(); }};
}
const listingRequest = () => new Request('http://localhost'+ROUTE+'?sessionId=turn-test');

test('observer captures boundary synchronously before next and preserves exact stream identity; end events refresh list without another call', async () => {
  const store = await fresh(); const session = new Session(); session.start(1); const control = host(store,{value:session});
  const input = Object.freeze({...options(),messages:Object.freeze([])});
  const stream = {async *[Symbol.asyncIterator](){throw new Error('must not be consumed');}};
  let nextCalls = 0;
  assert.equal(control.hooks.get('llm/stream')(input,() => {nextCalls++; const end = session.end(1); control.hooks.get('session/event')(session,end); return stream;}),stream);
  assert.equal(nextCalls,1);
  const listing = await (await control.route.fetch(listingRequest())).json();
  assert.equal(listing.records[0].turn,1); assert.equal(listing.records[0].step,1); assert.equal(listing.records[0].turnStartSeq,0);
  assert.equal(listing.records[0].inputEventCount,2);
  assert.equal(listing.records[0].turnInfo.status,'completed');
  assert.equal(listing.rounds.completedTurnCount,1);
  assert.equal((await control.route.fetch(listingRequest())).headers.get('cache-control'),'no-store');
  await control.close(); await store.dispose();
});

test('round tracking failures do not fail capture or block authenticated list/get snapshot APIs', async () => {
  const store = await fresh(); const session = new Session(); session.start(1); session.snapshotEvents = () => { throw new Error('private log failure'); };
  const control = host(store,{value:session}); const stream = {};
  assert.equal(control.hooks.get('llm/stream')(options(),() => stream),stream);
  const listing = await (await control.route.fetch(listingRequest())).json();
  assert.equal(listing.records.length,1); assert.equal(listing.failures.length,0);
  assert.equal(listing.rounds.available,false); assert.equal(listing.records[0].turnInfo,null);
  const response = await control.route.fetch(new Request('http://localhost'+ROUTE+'?sessionId=turn-test&requestId='+listing.records[0].id));
  assert.equal(response.status,200); assert.equal((await response.json()).request.messages.length,1);
  assert.ok(!JSON.stringify(listing.rounds).includes('private log failure'));
  await control.close(); await store.dispose();
});

test('throwing Session seq getter is isolated before capture and next still gets the original stream', async () => {
  const store = await fresh();
  const session = {id:'turn-test',snapshotEvents(){return [];},get seq(){throw new Error('getter failed');}};
  const control = host(store,{value:session}); const stream = {};
  assert.equal(control.hooks.get('llm/stream')(options(),() => stream),stream);
  const listing = await (await control.route.fetch(listingRequest())).json();
  assert.equal(listing.records.length,1); assert.equal(listing.records[0].inputEventCount,null);
  assert.equal(listing.rounds.available,false); assert.equal(listing.failures.length,0);
  await control.close(); await store.dispose();
});

for (const failure of ['snapshot','header','seq']) test(`replacement Session ${failure} failure cannot associate new captures with the older log, even after recovery`, async () => {
  const store = await fresh(), original = new Session(); original.start(1);
  for (let index=0; index<20; index++) original.append('assistant/message',{content:'fixture'});
  const reference = {value:original}, control = host(store,reference), stream = {};
  assert.equal(control.hooks.get('llm/stream')(options(),() => stream),stream);
  const initial = await (await control.route.fetch(listingRequest())).json();
  const oldId = initial.records[0].id;
  assert.equal(initial.records[0].turnInfo.turn,1);
  const replacement = new Session('turn-test',{createdAt:456}); replacement.start(9);
  if (failure === 'snapshot') replacement.snapshotEvents = () => { throw new Error('unreadable replacement'); };
  if (failure === 'header') Object.defineProperty(replacement,'header',{configurable:true,get(){throw new Error('unreadable identity');}});
  if (failure === 'seq') Object.defineProperty(replacement,'seq',{configurable:true,get(){throw new Error('unreadable seq');}});
  reference.value = replacement;
  assert.equal(control.hooks.get('llm/stream')(options(),() => stream),stream);
  const failed = await (await control.route.fetch(listingRequest())).json();
  const bad = failed.records.find(row => row.id !== oldId);
  assert.equal(bad.turnAssociationVerified,false);
  assert.equal(bad.turnInfo,null);
  assert.equal(bad.turnIndexId,null);
  assert.equal(failed.records.find(row => row.id === oldId).turnInfo.turn,1);
  assert.equal(failed.rounds.unassignedMainCallCount,1);
  if (failure !== 'seq') assert.equal(bad.inputEventCount,2);
  // Recover the original log: prefix 2 belongs to old turn 1, but the failed capture
  // must never be treated as a legacy record and backfilled into that generation.
  reference.value = original;
  const restored = await (await control.route.fetch(listingRequest())).json();
  assert.equal(restored.records.find(row => row.id === oldId).turnInfo.turn,1);
  assert.equal(restored.records.find(row => row.id === bad.id).turnInfo,null);
  const response = await control.route.fetch(new Request('http://localhost'+ROUTE+'?sessionId=turn-test&requestId='+bad.id));
  assert.equal((await response.json()).meta.turnInfo,null);
  assert.equal(restored.rounds.currentCallCount,1);
  assert.equal(restored.failures.length,0);
  await control.close(); await store.dispose();
});

test('a rollback before pending sidecar hydration does not re-accept old generations even when boundaries replay identically', async () => {
  const store = await fresh(); const original = new Session(); original.start(1); const old = capture(store,original); await store.flush();
  const restarted = new ContextStore(store.root), live = new Session(); live.events = [...original.events];
  const provisional = capture(restarted,live);
  live.events.length = 0; restarted.syncSessionTurns(live);
  live.start(1); const freshId = capture(restarted,live);
  const listing = await restarted.list(live.id);
  assert.equal(listing.records.find(row => row.id === old).turnInfo,null);
  assert.equal(listing.records.find(row => row.id === provisional).turnInfo,null);
  assert.equal(listing.records.find(row => row.id === freshId).turnInfo.turn,1);
  assert.equal(listing.rounds.unassignedMainCallCount,2);
  await store.dispose(); await restarted.dispose();
});

test('disposed stores reject turn synchronization and enqueue no fresh persistence work', async () => {
  const store = await fresh(); const session = new Session(); session.start(1); capture(store,session); await store.dispose();
  assert.equal(store.syncSessionTurns(session),null);
  assert.deepEqual(store.turnBoundary(session.id,session.seq),{});
  assert.equal(store.turnWrites.size,0);
  assert.equal(store.turns.states.size,0);
});

test('only boundary session events trigger synchronization; queue coalesces revisions and flush publishes latest state', async () => {
  const store = await fresh(); const session = new Session(); const control = host(store,{value:session});
  const message = session.append('user/message',{text:'private'}); control.hooks.get('session/event')(session,message);
  assert.equal(session.reads.length,0);
  const start = session.append('turn/start',{turn:1}); control.hooks.get('session/event')(session,start);
  const step = session.append('step/start',{turn:1,step:1}); control.hooks.get('session/event')(session,step);
  const endStep = session.append('step/end',{turn:1,step:1}); control.hooks.get('session/event')(session,endStep);
  const end = session.append('turn/end',{turn:1,reason:{kind:'completed'}}); control.hooks.get('session/event')(session,end);
  const listing = await (await control.route.fetch(listingRequest())).json();
  assert.equal(listing.rounds.turns[0].status,'completed'); assert.equal(listing.rounds.completedTurnCount,0);
  const persisted = JSON.parse(await readFile(file(store),'utf8')); assert.equal(persisted.cursor,session.seq);
  assert.equal(persisted.events.at(-1).data.reason.kind,'completed');
  assert.ok((await readdir(store.sessionPath(session.id))).every(name => !name.endsWith('.tmp')));
  await control.close(); await store.dispose();
});
