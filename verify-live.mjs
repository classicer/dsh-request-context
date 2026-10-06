// Read local snapshots only. Print counts, never prompt bodies or authentication data.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { ContextStore } from './store.js';
const sessionId=process.env.DSH_SESSION_ID;
if(!sessionId) throw new Error('Run from the relevant Harness session');
const store=new ContextStore(resolve(import.meta.dirname,'.state','desktop'));
const listing=await store.list(sessionId);
assert.ok(listing.records.length>0,'No real call captured yet');
assert.equal(listing.failures.length,0);
const newest=listing.records[0];
const result=await store.get(sessionId,newest.id);
assert.equal(result.request.sessionId,sessionId);
assert.equal(result.request.messages.length,newest.messageCount);
for(const message of result.request.messages) {
  assert.equal(typeof message.role,'string');
  assert.ok(Array.isArray(message.content));
}
for(const tool of result.request.tools ?? []) {
  assert.equal(typeof tool.name,'string');
  assert.equal(typeof tool.parameters,'object');
}
for(const key of ['apiKey','headers','authorization','accessToken','refreshToken','signal']) assert.equal(Object.hasOwn(result.request,key),false);
const roles=Object.fromEntries(['system','developer','user','assistant','tool'].map(role=>[role,result.request.messages.filter(message=>message.role===role).length]));
const first=listing.records.at(-1);
const firstMeta=JSON.parse(await readFile(store.recordPath(sessionId,first.id),'utf8'));
const latestMeta=JSON.parse(await readFile(store.recordPath(sessionId,newest.id),'utf8'));
const sharedMessages=latestMeta.request.messages.filter(hash=>firstMeta.request.messages.includes(hash)).length;
const objectDirectories=await readdir(resolve(store.root,'objects'));
const objectCount=(await Promise.all(objectDirectories.map(async directory=>(await readdir(resolve(store.root,'objects',directory))).filter(file=>file.endsWith('.json')).length))).reduce((a,b)=>a+b,0);
console.log(JSON.stringify({verified:true,capturedCalls:listing.records.length,provider:result.request.provider,model:result.request.model,messageCount:result.request.messages.length,roles,toolCount:result.request.tools?.length ?? 0,hasToolHistory:!!result.request.toolHistory,inputEventCount:newest.inputEventCount,sharedMessagesWithFirstCapture:sharedMessages,uniqueStoredObjects:objectCount,redactionCount:newest.redactions,authMetadataIncluded:false},null,2));
await store.dispose();
