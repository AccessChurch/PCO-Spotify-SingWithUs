import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSongs, makeClients } from '../src/api.js';
import { desiredTracks, createSync } from '../src/sync.js';
import { openStore } from '../src/store.js';
import { schedulePeriod } from '../src/schedule.js';
const uri = 'spotify:track:1234567890123456789012';
const memory = () => { const data = new Map(); return { get:(k,f=null)=>data.has(k)?data.get(k):f, set:(k,v)=>data.set(k,v) }; };
test('last Wednesday scheduling observes Eastern DST and catches up after restart', () => {
  assert.equal(schedulePeriod(new Date('2026-09-23T15:00:00Z')), null);
  assert.equal(schedulePeriod(new Date('2026-09-30T13:59:59Z')), null);
  assert.equal(schedulePeriod(new Date('2026-09-30T14:00:00Z')), '2026-09');
  assert.equal(schedulePeriod(new Date('2026-10-01T14:00:00Z')), null);
  assert.equal(schedulePeriod(new Date('2026-02-25T14:59:00Z')), null);
  assert.equal(schedulePeriod(new Date('2026-02-25T15:00:00Z')), '2026-02');
  assert.equal(schedulePeriod(new Date('2026-02-28T15:00:00Z')), '2026-02');
});
test('approval gate rejects empty, partial and invalid mappings', () => {
  assert.throws(()=>desiredTracks([], {}), /Empty/);
  assert.throws(()=>desiredTracks([{id:'1'},{id:'2'}], {'1':{uri,approvedAt:'date'}}), /await approval/);
  assert.throws(()=>desiredTracks([{id:'1'}], {'1':{uri:'bad',approvedAt:'date'}}), /Invalid/);
  assert.deepEqual(desiredTracks([{id:'1'},{id:'2'}], {'1':{uri,approvedAt:'date'},'2':{uri,approvedAt:'date'}}),[uri]);
});
test('180-day bounds, plan/item pagination, PCO ID dedupe preserve different songs with same title', async () => {
  const now = new Date('2026-09-16T12:00:00Z');
  const plan = (id,time) => ({id,attributes:{sort_date:time}});
  const song = id => ({attributes:{title:'Same title'},relationships:{song:{data:{id}}}});
  const paths=[];
  const pco = async path => { paths.push(path);
    if(path.includes('/items')) return {data:[song('1'),song('2')],links:{next:path==='items2'?null:'items2'}};
    if(path==='items2') return {data:[song('1')]};
    if(path==='plans2') return {data:[plan('old',new Date(now-181*86400000).toISOString())]};
    return {data:[plan('future','2026-09-17T12:00:00Z'),plan('current',now.toISOString()),plan('boundary',new Date(now-180*86400000).toISOString())],links:{next:'plans2'}};
  };
  const songs=await collectSongs(pco,'10670',now);
  assert.deepEqual(songs.map(x=>x.id),['1','2']);
  assert.ok(paths.some(x=>x.includes('/boundary/items')));
  assert.ok(!paths.some(x=>x.includes('/future/items')||x.includes('/old/items')));
});
function fixture(count=1) {
  const store=memory(), writes=[];
  const songs=Array.from({length:count},(_,i)=>({id:String(i),attributes:{title:`Song ${i}`},relationships:{song:{data:{id:String(i)}}}}));
  const pco=async path=>path.includes('/items')?{data:songs}:{data:[{id:'plan',attributes:{sort_date:new Date().toISOString()}}]};
  let current=['spotify:track:9999999999999999999999'];
  const spotify=async (path,method='GET',body)=>{
    if(method!=='GET'){writes.push({path,method,body});current=method==='PUT'?body.uris:[...current,...body.uris];return {};}
    return path.includes('/items')?{items:current.map(uri=>({item:{uri}})),next:null}:{snapshot_id:'stable'};
  };
  return {store,writes,pco,spotify,config:{serviceType:'10670',playlist:'target'}};
}
test('unapproved and disabled runs never touch Spotify', async()=>{
  const f=fixture(); let calls=0; const sync=createSync(f.config,f.store,{pco:f.pco,spotify:async()=>{calls++;}});
  await assert.rejects(sync.run(),/approval/); assert.equal(calls,0);
  f.store.set('mappings',{'0':{uri,approvedAt:'date'}});
  await assert.rejects(sync.run(),/disabled/); assert.equal(calls,0);
});
test('source failures preserve last discovery and never write', async()=>{
  const f=fixture(); f.store.set('songs',[{id:'previous'}]);
  const sync=createSync(f.config,f.store,{pco:async()=>{throw new Error('source failed');},spotify:f.spotify});
  await assert.rejects(sync.run(),/source failed/);assert.deepEqual(f.store.get('songs'),[{id:'previous'}]);assert.equal(f.writes.length,0);
});
test('approved sync backs up, chunks over 100, uses /items, and is idempotent', async()=>{
  const f=fixture(101);f.store.set('enabled',true);
  f.store.set('mappings',Object.fromEntries(Array.from({length:101},(_,i)=>[String(i),{uri:`spotify:track:${String(i).padStart(22,'0')}`,approvedAt:'date'}])));
  const sync=createSync(f.config,f.store,f);await sync.run();
  assert.equal(f.writes.length,2);assert.equal(f.writes[0].method,'PUT');assert.equal(f.writes[0].body.uris.length,100);
  assert.equal(f.writes[1].body.uris.length,1);assert.ok(f.writes.every(x=>x.path.endsWith('/items')));
  assert.equal(f.store.get('backup').uris.length,1);assert.equal(f.store.get('writeInProgress'),null);
  await sync.run(); assert.equal(f.writes.length,2);
});
test('ambiguous write failure persists recovery gate and blocks later writes',async()=>{
  const f=fixture();f.store.set('enabled',true);f.store.set('mappings',{'0':{uri,approvedAt:'date'}});
  const sync=createSync(f.config,f.store,{pco:f.pco,spotify:async(...args)=>{if(args[1]==='PUT')throw new Error('connection lost');return f.spotify(...args);}});
  await assert.rejects(sync.run(),/connection lost/);assert.ok(f.store.get('backup'));assert.ok(f.store.get('writeInProgress'));
  await assert.rejects(sync.run(),/incomplete/);
});
test('mappings and refresh tokens persist across restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pco-sync-'));
  try {let store=openStore(dir);store.set('mappings',{'1':{uri,approvedAt:'date'}});store.set('tokens',{refresh_token:'secret'});store.close();store=openStore(dir);assert.equal(store.get('mappings')['1'].uri,uri);assert.equal(store.get('tokens').refresh_token,'secret');store.close();}finally{rmSync(dir,{recursive:true,force:true});}
});
test('OAuth refresh retains old refresh token and retries a 401 once',async()=>{
  const original=globalThis.fetch,store=memory();store.set('tokens',{access_token:'old',refresh_token:'refresh',expiresAt:Date.now()+300000});let count=0;
  globalThis.fetch=async(url,options)=>{
    if(String(url).includes('/api/token'))return Response.json({access_token:'new',expires_in:3600});
    count++;return options.headers.Authorization==='Bearer old'?new Response('',{status:401}):Response.json({ok:true});
  };
  try {const clients=makeClients({spotifyId:'id',spotifySecret:'secret'},store);assert.deepEqual(await clients.spotify('me'),{ok:true});assert.equal(count,2);assert.equal(store.get('tokens').refresh_token,'refresh');}finally{globalThis.fetch=original;}
});
