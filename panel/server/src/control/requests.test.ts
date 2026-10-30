import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlLeases, type Actor } from './leases.js';
import { ControlRequests } from './requests.js';
import { humanActor } from './actors.js';
const owner=humanActor({id:'one',username:'One'}), other=humanActor({id:'two',username:'Two'});
const agent:Actor={kind:'agent',id:'client:test',label:'Agent'};
async function fixture(){
  let now=1000,allowed=true;const l=new ControlLeases(()=>now,300000);
  await l.ensure('a',1,{revoke:async()=>{},reset:async()=>{},grantHuman:async()=>{}});
  const r=new ControlRequests(l,()=>allowed,()=>now);
  return {l,r,advance:()=>now+=60001,revoke:()=>allowed=false};
}
test('same authenticated user shares ownership across tabs; others must obtain consent',async()=>{
  const {l,r}=await fixture();const initial=await r.request('a',owner);
  assert.equal(l.status('a',humanActor({id:'one',username:'One'},'different-tab')).mine,true);
  const pending=await r.request('a',other);assert.equal(pending.mine,false);assert.equal(l.status('a',owner).epoch,initial.epoch);
  assert.equal(r.status('a',owner).request?.canRespond,true);
  await assert.rejects(r.respond('a',other,initial.epoch,pending.request!.id,true));
  await assert.rejects(r.respond('a',owner,'old-epoch',pending.request!.id,true));
  await r.respond('a',owner,initial.epoch,pending.request!.id,true);
  assert.equal(l.status('a',other).mine,true);assert.equal(l.status('a',owner).mine,false);
  assert.equal(r.status('a',other).request,null);
  await assert.rejects(l.write('a',owner,initial.epoch,async()=>{}));
});
test('one pending request, stable repeat, cancel/reject and expiration never auto-grant',async()=>{
  const {l,r,advance}=await fixture();const initial=await r.request('a',owner);
  const one=await r.request('a',other);assert.equal((await r.request('a',other)).request?.id,one.request?.id);
  await assert.rejects(r.request('a',agent),/已有待处理/);
  assert.throws(()=>r.cancel('a',owner,one.request!.id));
  r.cancel('a',other,one.request!.id);assert.equal(l.status('a',owner).mine,true);
  const two=await r.request('a',other);await r.respond('a',owner,initial.epoch,two.request!.id,false);
  assert.equal(l.status('a',owner).mine,true);
  const three=await r.request('a',other);advance();assert.equal(r.status('a',other).request,null);
  await assert.rejects(r.respond('a',owner,initial.epoch,three.request!.id,true));
  assert.equal(l.status('a',owner).mine,true);
});
test('requests bind to current ownership and recheck requester access',async()=>{
  const {l,r,revoke}=await fixture();const initial=await r.request('a',owner);
  const pending=await r.request('a',other);revoke();
  await assert.rejects(r.respond('a',owner,initial.epoch,pending.request!.id,true));
  assert.equal(l.status('a',owner).mine,true);
  const second=await fixture();const first=await second.r.request('a',owner);const req=await second.r.request('a',other);
  await second.l.release('a',owner,first.epoch);await second.r.request('a',owner);
  await assert.rejects(second.r.respond('a',owner,second.l.status('a').epoch,req.request!.id,true));
});
test('generic approved agent transfer drains current input before granting ownership',async()=>{
  const {l,r}=await fixture();const initial=await r.request('a',owner);const req=await r.request('a',agent);
  let finish!:()=>void;const action=l.write('a',owner,initial.epoch,()=>new Promise<void>(done=>{finish=done;}));
  const approve=r.respond('a',owner,initial.epoch,req.request!.id,true);
  assert.equal(l.status('a').state,'handover');assert.equal(l.status('a',agent).mine,false);
  finish();await action;await approve;assert.equal(l.status('a',agent).mine,true);
  assert.equal(l.client('a',agent).epoch,l.status('a').epoch);
});
