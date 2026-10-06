import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ContextStore, maskJson } from './store.js';
import { apply, ROUTE } from './index.js';

const testingRoot = resolve(import.meta.dirname, '.test-state');
await mkdir(testingRoot, { recursive:true });
const fresh = async () => new ContextStore(await mkdtemp(join(testingRoot, 'run-')));
const message = (id, role, text, kind = role) => ({ id, role, source:{ kind }, content:[{ type:'text', text }] });
const options = overrides => ({ provider:'test-provider', model:'test-model', sessionId:'session-test', messages:[message('sys','system','system rules','system-prompt'), message('usr','user','hello','user')], tools:[{ name:'read', description:'read files', parameters:{ type:'object', properties:{ path:{ type:'string' } } } }], toolHistory:{ tools:[], updates:[] }, ...overrides });
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };

// No live credentials, provider calls or user sessions are used in these tests.
test('round-trip preserves full logical structure, order, tool history and references', async () => {
  const store = await fresh();
  const input = options({ messages:[message('sys','system','rules','system-prompt'), message('inject','user','agent instructions','agent-instructions'), message('human','user','question','user-rpc'), { id:'a', role:'assistant', source:{kind:'model'}, content:[{type:'tool-call', callId:'call', name:'read', arguments:{path:'example'}}] }, {id:'tool',role:'tool',source:{kind:'tool'},content:[{type:'image',attachment:{attachmentId:'image-id',mimeType:'image/png'}}],toolCallId:'call'}], maxTokens:500, reasoningEffort:'high', system:'optional distinct system', toolHistory:{tools:[{name:'removed-tool',parameters:{}}],updates:[{messageId:'d',additions:[{name:'new-tool',parameters:{}}]}]}, signal:new AbortController().signal });
  const id = store.capture(input, {inputEventCount:123});
  const snapshot = await store.get(input.sessionId,id);
  const {signal,...expected} = input;
  assert.deepEqual(snapshot.request,expected);
  assert.equal(snapshot.meta.inputEventCount,123);
  assert.deepEqual(snapshot.meta.omittedFields,['signal']);
  assert.equal((await store.list(input.sessionId)).records.length,1);
  await store.dispose();
});

test('synchronous copy protects against later mutations and preserves exact calls on restart', async () => {
  const store = await fresh();
  const input = options();
  const id = store.capture(input);
  input.messages[1].content[0].text='mutated after capture';
  input.tools[0].description='later';
  await store.flush();
  const restarted = new ContextStore(store.root);
  assert.equal((await restarted.get('session-test',id)).request.messages[1].content[0].text,'hello');
  assert.equal((await restarted.get('session-test',id)).request.tools[0].description,'read files');
  await store.dispose(); await restarted.dispose();
});

test('CAS deduplicates unchanged messages, tools and tool history; only new content adds objects', async () => {
  const store = await fresh();
  const input = deepFreeze(options());
  const first = store.capture(input);
  const second = store.capture(input);
  await store.flush();
  const count = async () => (await Promise.all((await readdir(join(store.root,'objects'))).map(async directory => (await readdir(join(store.root,'objects',directory))).length))).reduce((a,b)=>a+b,0);
  assert.equal(await count(),4);
  assert.deepEqual((await store.get('session-test',first)).request,(await store.get('session-test',second)).request);
  store.capture({...input,messages:[...input.messages,message('next','assistant','answer','model')]});
  await store.flush();
  assert.equal(await count(),5);
  assert.equal(store.cache.has(input.messages[0]),true);
  await store.dispose();
});

test('shallow-frozen values are not incorrectly cached', async () => {
  const store = await fresh();
  const msg = Object.freeze(message('m','user','first','user'));
  const input=options({messages:[msg]});
  const first=store.capture(input);
  msg.content[0].text='second';
  const second=store.capture(input);
  assert.equal((await store.get('session-test',first)).request.messages[0].content[0].text,'first');
  assert.equal((await store.get('session-test',second)).request.messages[0].content[0].text,'second');
  await store.dispose();
});

test('credentials are excluded, embedded common secrets masked, parameter schemas preserved', async () => {
  const store = await fresh();
  const token='sk-test-fake-key-not-a-real-credential-0001';
  const input=options({apiKey:token, headers:{authorization:'Bearer private-token'}, messages:[message('m','user',`example Bearer abc.def.ghi and ${token}`,'user'),{id:'t',role:'assistant',source:{kind:'model'},content:[{type:'tool-call',name:'connect',arguments:{password:'plain password',apiKey:token}}]}],tools:[{name:'connect',description:'connect',parameters:{type:'object',properties:{apiKey:{type:'string',description:'API key field'}}}}]});
  const result=await store.get('session-test',store.capture(input));
  assert.equal(JSON.stringify(result).includes(token),false);
  assert.equal(JSON.stringify(result).includes('plain password'),false);
  assert.equal(result.request.apiKey,undefined);
  assert.equal(result.request.headers,undefined);
  assert.equal(result.request.tools[0].parameters.properties.apiKey.type,'string');
  assert.equal(result.meta.redactions,4);
  assert.deepEqual(JSON.parse(JSON.stringify(maskJson({authorization:{type:'string'}}))),{authorization:{type:'string'}});
  await store.dispose();
});

test('auxiliary calls keep their own inputs and purpose, not a guessed main-session context', async () => {
  const store = await fresh();
  const input=options({purpose:'compaction',system:'compact instructions',messages:[message('c','user','compact only this','user')]});
  const result=await store.get('session-test',store.capture(input));
  assert.deepEqual(result.request,input);
  assert.equal(result.meta.purpose,'compaction');
  assert.equal(store.capture(options({sessionId:undefined})),undefined);
  await store.dispose();
});

test('session separation, invalid paths and corrupt objects fail closed', async () => {
  const store=await fresh();
  const id=store.capture(options());
  await store.flush();
  assert.equal((await store.list('other-session')).records.length,0);
  await assert.rejects(store.get('other-session',id));
  await assert.rejects(store.get('session-test','../../escape'));
  await assert.rejects(store.readBlob('../escape'));
  const record=JSON.parse(await readFile(store.recordPath('session-test',id),'utf8'));
  await writeFile(store.blobPath(record.request.messages[0]),'{"corrupted":true}');
  await assert.rejects(store.get('session-test',id),/integrity/);
  await store.dispose();
});

test('synchronous observer captures before next, preserves stream and uses authenticated Fetch registry', async () => {
  const store = await fresh();
  const hooks=new Map(); const disposers=[]; let route; let nextCalled=false;
  const ctx={sessions:{get:()=>({seq:321})},on:(event,listener)=>{hooks.set(event,listener);},effect:callback=>{const disposer=callback();disposers.push(disposer);return disposer;},connection:{fetch:{register: value=>{route=value;return async()=>{};}}}};
  apply(ctx,{dataDir:store.root});
  const input=options();
  const stream={async *[Symbol.asyncIterator](){yield {type:'text',text:'unchanged'};}};
  const observed=hooks.get('llm/stream')(input,()=>{nextCalled=true;input.messages[1].content[0].text='changed inside next';return stream;});
  assert.equal(nextCalled,true);
  assert.equal(observed,stream);
  assert.equal(route.path,ROUTE);
  assert.deepEqual(route.methods,['GET']);
  const invalid=await route.fetch(new Request('http://localhost'+ROUTE));
  assert.equal(invalid.status,400);
  const response=await route.fetch(new Request('http://localhost'+ROUTE+'?sessionId=session-test'));
  assert.equal(response.headers.get('cache-control'),'no-store');
  const listing=await response.json();
  assert.equal(listing.records.length,1);
  const read=await route.fetch(new Request('http://localhost'+ROUTE+'?sessionId=session-test&requestId='+listing.records[0].id));
  const result=await read.json();
  assert.equal(result.request.messages[1].content[0].text,'hello');
  assert.equal(result.meta.inputEventCount,321);
  for(const dispose of disposers.reverse()) if(typeof dispose==='function') await dispose();
  await store.dispose();
});
