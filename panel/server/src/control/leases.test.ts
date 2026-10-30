import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlLeases, type Actor, type ControlAdapter } from './leases.js';
const human: Actor = { kind: 'human', id: 'user:one', label: 'Human 1' };
const other: Actor = { ...human, id: 'user:two', label: 'Human 2' };
const agent: Actor = { kind: 'agent', id: 'task1', label: 'Agent' };
function fixture() {
  let now=1000; const calls: string[]=[];
  const adapter: ControlAdapter = { revoke: async()=>{calls.push('revoke');}, reset: async hard=>{calls.push(hard?'fence':'reset');}, grantHuman:async()=>{calls.push('grant');} };
  const leases=new ControlLeases(()=>now,100);
  return { leases, adapter, calls, advance:()=>{now+=101;} };
}
test('different users compete; old epoch is rejected; agent cannot steal', async()=>{
  const {leases:l,adapter}=fixture();await l.ensure('a',1,adapter);
  const one=await l.take('a',human);assert.ok(one.mine);assert.equal(l.status('a',other).mine,false);
  await assert.rejects(l.take('a',agent),/已有操作者/);
  const two=await l.take('a',other,true);assert.ok(two.mine);assert.notEqual(one.epoch,two.epoch);
  await assert.rejects(l.write('a',human,one.epoch,async()=>{}),/失效/);
});
test('handover drains an in-flight operation and revokes new calls before granting human', async()=>{
  const {leases:l,adapter,calls}=fixture();await l.ensure('a',1,adapter);const a=await l.take('a',agent);
  let finish!:()=>void;const action=l.write('a',agent,a.epoch,()=>new Promise<void>(r=>{finish=r;}));
  const handover=l.take('a',human,true);
  assert.equal(l.status('a',human).state,'handover');assert.throws(()=>l.agent('a',a.token!),/租约/);
  await l.ensure('a',1,adapter); // status polling must not wait for the old action.
  assert.equal(calls.filter(x=>x==='grant').length,0);
  finish();await action;const result=await handover;assert.ok(result.mine);
  assert.deepEqual(calls.slice(-3),['revoke','reset','grant']);
});
test('timeout revokes leases, releases input, and requires a new epoch', async()=>{
  const {leases:l,adapter,advance}=fixture();await l.ensure('a',1,adapter);const a=await l.take('a',agent);
  advance();l.tick();assert.throws(()=>l.agent('a',a.token!),/租约/);
  await new Promise(r=>setImmediate(r));assert.equal(l.status('a').state,'idle');
  const b=await l.take('a',agent);assert.notEqual(a.epoch,b.epoch);assert.notEqual(a.token,b.token);
});
test('uncertain completion fails closed until explicit hard recovery; generations invalidate', async()=>{
  const {leases:l,adapter,calls}=fixture();await l.ensure('a',1,adapter);const a=await l.take('a',agent);
  await assert.rejects(l.write('a',agent,a.epoch,async()=>{throw Error('lost response');}));
  await new Promise(r=>setImmediate(r));assert.equal(l.status('a').state,'faulted');
  await assert.rejects(l.take('a',human,true),/不确定/);
  await l.recover('a');assert.equal(l.status('a').state,'idle');assert.equal(calls.filter(x=>x==='fence').length,2);
  const h=await l.take('a',human);await l.ensure('a',2,adapter);
  await assert.rejects(l.write('a',human,h.epoch,async()=>{}));
});
test('permission or input reset failure never reports a successful takeover',async()=>{
  const {leases:l,adapter}=fixture();await l.ensure('a',1,adapter);
  adapter.reset=async()=>{throw Error('X unavailable');};const result=await l.take('a',human);
  assert.equal(result.mine,false);assert.equal(result.state,'faulted');
});
test('recovery revokes a late permission grant before it can accept a fresh owner',async()=>{
  const {leases:l,adapter,calls}=fixture();await l.ensure('a',1,adapter);
  let finish!:()=>void, entered!:()=>void;const pending=new Promise<void>(r=>entered=r);
  adapter.grantHuman=async()=>{entered();await new Promise<void>(r=>finish=r);calls.push('late-grant');};
  const take=l.take('a',human);await pending;const recover=l.recover('a');
  assert.equal(l.status('a').state,'handover');finish();await take;await recover;
  assert.equal(l.status('a').state,'idle');assert.deepEqual(calls.slice(-3),['late-grant','revoke','fence']);
});
test('recovery waits for the entire HTTP action before fencing its input helper',async()=>{
  const {leases:l,adapter,calls}=fixture();await l.ensure('a',1,adapter);const a=await l.take('a',human);
  let finish!:()=>void;const action=l.write('a',human,a.epoch,()=>new Promise<void>(r=>finish=r));
  const recovery=l.recover('a');assert.equal(l.status('a').state,'faulted');assert.equal(calls.filter(c=>c==='fence').length,1);
  finish();await action;await recovery;assert.equal(calls.filter(c=>c==='fence').length,2);assert.equal(l.status('a').state,'idle');
});
test('maintenance blocks old input, drains actions and rejects late HTTP helper dispatch',async()=>{
  const {leases:l,adapter}=fixture();await l.ensure('a',1,adapter);const a=await l.take('a',agent);
  let finish!:()=>void;const pending=new Promise<void>(r=>finish=r);let sent=false;
  const action=l.write('a',agent,a.epoch,async check=>{await pending;check();sent=true;});
  const draining=l.suspend('a','upgrade');assert.equal(l.status('a').state,'maintenance');await assert.rejects(l.take('a',human,true));
  finish();await assert.rejects(action);await draining;assert.equal(sent,false);
  l.prepareResume('a');await l.ensure('a',2,adapter,false,true);assert.equal(l.ready('a'),true);assert.equal(l.status('a').state,'maintenance');
  l.endMaintenance('a');assert.equal(l.status('a').state,'idle');assert.ok((await l.take('a',human)).mine);
});

test('a durable journal failure revokes ownership before reporting the fault', async () => {
  const { adapter } = fixture(); let fail = false;
  const l = new ControlLeases(Date.now, 30000, { end: () => { if (fail) throw Error('disk full'); } });
  await l.ensure('a', 1, adapter);
  const grant = await l.take('a', agent); fail = true;
  await l.release('a', agent, grant.epoch);
  assert.equal(l.status('a').state, 'faulted');
  assert.throws(() => l.agent('a', grant.token!), /有效/);
  await assert.rejects(l.write('a', agent, grant.epoch, async () => {}), /失效/);
});

test('stable client lock: queries and repeated acquire do not renew; writes do; expiry cannot revive', async () => {
  let now = 1000;
  const { adapter } = fixture(); const l = new ControlLeases(() => now, 30, {}, 120);
  await l.ensure('a', 1, adapter); const a = await l.take('a', agent, false, true);
  assert.equal(a.expiresAt, 1120);
  now = 1050; assert.equal(l.status('a', agent).expiresAt, 1120);
  assert.equal((await l.take('a', agent, false, true)).expiresAt, 1120);
  assert.throws(() => l.client('a', { ...agent, id: 'another' }), e => (e as any).code === 'WOC_LOCK_BUSY');
  const owner = l.client('a', agent); await l.write('a', owner.actor, owner.epoch, async () => { now = 1060; });
  assert.equal(l.status('a').expiresAt, 1180);
  now = 1181; assert.throws(() => l.client('a', agent), e => (e as any).code === 'WOC_LOCK_EXPIRED');
  await new Promise(r => setImmediate(r));
  const b = await l.take('a', agent, false, true);
  await assert.rejects(l.release('a', agent, a.epoch));
  assert.equal(l.status('a', agent).mine, true);
  await l.release('a', agent, b.epoch); assert.equal(l.status('a').free, true);
});
test('idle timeout does not hand off an in-flight write; completion starts a new idle interval', async () => {
  let now = 0; const { adapter } = fixture(); const l = new ControlLeases(() => now, 30, {}, 120);
  await l.ensure('a', 1, adapter); const a = await l.take('a', agent, false, true);
  let done!: () => void; const writing = l.write('a', agent, a.epoch, () => new Promise<void>(r => done = r));
  now = 200; l.tick(); assert.equal(l.status('a', agent).mine, true);
  await assert.rejects(l.take('a', { ...agent, id: 'other' }, false, true));
  done(); await writing; assert.equal(l.status('a').expiresAt, 320);
});
