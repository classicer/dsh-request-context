import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ContextStore, maskJson } from './store.js';
import { apply } from './index.js';
const root = resolve(import.meta.dirname, '.test-state');
await mkdir(root,{recursive:true});
const fresh = async () => new ContextStore(await mkdtemp(join(root,'review-')));
const input = () => ({provider:'test',model:'test',sessionId:'review-session',messages:[{id:'m',role:'user',source:{kind:'user'},content:[{type:'text',text:'x'}]}]});

test('frozen accessors and nonplain objects are never cached as immutable JSON',async()=>{
  const store=await fresh(); let counter=1;
  const value=Object.freeze({get text(){return counter;}});
  assert.equal(store.cachedChunk(value).text,'{"text":1}');
  counter=2;
  assert.equal(store.cachedChunk(value).text,'{"text":2}');
  assert.equal(store.cache.has(value),false);
  assert.equal(store.isDeepFrozen(Object.freeze(new Date())),false);
  await store.dispose();
});

test('arrays under secret keys and JSON-string tool arguments are masked',()=>{
  const masked=maskJson({apiKey:['not-a-pattern-secret'],arguments:'{"apiKey":"another plain secret","path":"public-path"}'});
  assert.equal(masked.apiKey,'[REDACTED]');
  assert.deepEqual(JSON.parse(masked.arguments),{apiKey:'[REDACTED]',path:'public-path'});
});

test('preexisting corrupt object is rejected, not accepted as a reusable CAS block',async()=>{
  const store=await fresh();
  const options=input(); const chunk=store.chunk(options.messages[0]);
  const path=store.blobPath(chunk.hash);
  await mkdir(resolve(path,'..'),{recursive:true});
  await writeFile(path,'truncated');
  store.capture(options);
  const list=await store.list('review-session');
  assert.equal(list.records.length,0);
  assert.equal(list.failures[0].code,'STORE_CORRUPT');
  await store.dispose();
});

test('sync capture failures are visible and next still receives the original stream',async()=>{
  const store=await fresh(); const hooks=new Map(); const disposers=[];let route;
  const ctx={sessions:{get:()=>({seq:1})},on:(name,fn)=>hooks.set(name,fn),effect:fn=>{disposers.push(fn());},connection:{fetch:{register:r=>{route=r;return async()=>{};}}}};
  apply(ctx,{dataDir:store.root});
  const options=input();options.messages[0].content[0].cycle=options.messages[0];
  const stream={async *[Symbol.asyncIterator](){yield 'same';}};
  let count=0;
  assert.equal(hooks.get('llm/stream')(options,()=>{count++;return stream;}),stream);
  assert.equal(count,1);
  const list=await (await route.fetch(new Request('http://localhost/api/local-request-context?sessionId=review-session'))).json();
  assert.equal(list.records.length,0);
  assert.equal(list.failures.length,1);
  for(const dispose of disposers.reverse()) if(typeof dispose==='function') await dispose();
  await store.dispose();
});
