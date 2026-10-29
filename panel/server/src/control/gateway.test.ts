import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { ControlLeases, type Actor } from './leases.js';
import { createControlGateway } from './gateway.js';
const agent: Actor={kind:'agent',id:'task',label:'Agent'}, human: Actor={kind:'human',id:'tab',label:'Human'};
const frame=Buffer.alloc(5), trailer=Buffer.from('grpc-status: 0\r\n'), header=Buffer.alloc(5);
header[0]=128;header.writeUInt32BE(trailer.length,1);const success=Buffer.concat([header,trailer]);
async function fixture(t: any, handler: http.RequestListener) {
  const upstream=http.createServer(handler), leases=new ControlLeases();let ensures=0;
  const adapter={revoke:async()=>{},reset:async()=>{},grantHuman:async()=>{}};
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const gateway=createControlGateway(()=>({id:'a',upstream:origin,viewToken:'view',rawToken:'raw',ensure:async()=>{ensures++;await leases.ensure('a',1,adapter);}}),leases);
  await new Promise<void>(r=>gateway.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  t.after(()=>{gateway.closeAllConnections();gateway.close();upstream.closeAllConnections();upstream.close();});
  const post=(method:string,token:string)=>fetch(url+'/cua.env.v1.'+method,{method:'POST',headers:{'content-type':'application/grpc-web+proto',authorization:'Bearer '+token},body:frame});
  return {leases,post,url,gateway,ensures:()=>ensures,initialize:()=>leases.ensure('a',1,adapter)};
}
test('untrusted requests cannot fence; view credentials cannot write or bypass allowlist',async t=>{
  let forwarded=0;const f=await fixture(t,(req,res)=>{forwarded++;assert.equal(req.headers.authorization,'Bearer raw');res.end(success);});
  assert.match(await (await f.post('ComputerService/Screenshot','invalid')).text(), /grpc-status: [1-9]/);assert.equal(f.ensures(),0);
  assert.match(await (await f.post('ProcessService/Exec','view')).text(), /grpc-status: 7/);assert.equal(f.ensures(),0);
  const observed=await f.post('ComputerService/Screenshot','view');assert.equal(observed.status,200,await observed.text());
  assert.match(await (await f.post('ComputerService/Keyboard','view')).text(), /grpc-status: [1-9]/);assert.equal(forwarded,1);
});
test('disconnecting a mutation client retains its in-flight handover fence',async t=>{
  let finish!:()=>void, started!:()=>void;const dispatched=new Promise<void>(r=>started=r);
  const f=await fixture(t,(_req,res)=>{finish=()=>res.end(success);started();});await f.initialize();const grant=await f.leases.take('a',agent);
  const request=http.request(f.url+'/cua.env.v1.ComputerService/Keyboard',{method:'POST',headers:{'content-type':'application/grpc-web+proto',authorization:'Bearer '+grant.token}});
  request.on('error',()=>{});request.end(frame);await dispatched;request.destroy();
  const take=f.leases.take('a',human,true);assert.equal(f.leases.status('a').state,'handover');
  assert.match(await (await f.post('ComputerService/Keyboard',grant.token!)).text(), /grpc-status: 7/);
  assert.equal(f.leases.status('a').inflight,1);finish();assert.equal((await take).mine,true);
});
test('upstream interruption leaves control faulted until explicit recovery',async t=>{
  const f=await fixture(t,(req)=>req.socket.destroy());await f.initialize();const grant=await f.leases.take('a',agent);
  assert.match(await (await f.post('ComputerService/Keyboard',grant.token!)).text(), /WOC_ACTION_UNCERTAIN/);
  await new Promise(r=>setImmediate(r));assert.equal(f.leases.status('a').state,'faulted');
  await assert.rejects(f.leases.take('a',human,true));await f.leases.recover('a');assert.equal(f.leases.status('a').state,'idle');
});
test('HTTP/2 probe reset does not crash the HTTP/1 fallback gateway',async t=>{
  const f=await fixture(t,(_req,res)=>res.end(success));
  await new Promise<void>(resolve=>{
    const s=net.connect((f.gateway.address() as AddressInfo).port,'127.0.0.1',()=>s.write('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'));
    s.on('data',()=>s.resetAndDestroy());s.on('error',()=>{});s.on('close',()=>resolve());
  });
  const observed=await f.post('ComputerService/Screenshot','view');assert.equal(observed.status,200,await observed.text());
});

test('stable credentials span read, lock, write and release; MCP lock errors reach the client', async t => {
  let calls = 0, ensures = 0;
  const upstream = http.createServer((req, res) => { calls++; assert.equal(req.headers.authorization, 'Bearer raw'); res.end(success); });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const leases = new ControlLeases(), adapter = { revoke: async () => {}, reset: async () => {}, grantHuman: async () => {} };
  const client = { id: 'a', label: 'A', tokenHash: '', machines: ['a'] };
  const gateway = createControlGateway(() => ({ id: 'a', upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, rawToken: 'raw', viewToken: 'view', ensure: async () => { ensures++; } }), leases, token => token === 'stable' ? client : undefined);
  await new Promise<void>(r => gateway.listen(0, '127.0.0.1', r));
  t.after(() => { gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); });
  const url = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const rpc = (method: string) => fetch(url + '/cua.env.v1.' + method, { method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', authorization: 'Bearer stable' }, body: frame });
  await rpc('ComputerService/Screenshot'); assert.equal(calls, 1); assert.equal(ensures, 0); assert.equal(leases.initialized('a'), false);
  await leases.ensure('a', 1, adapter);
  assert.match(await (await rpc('ComputerService/Pointer')).text(), /WOC_LOCK_REQUIRED/); assert.equal(calls, 1);
  const mcp = await fetch(url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer stable' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'click', arguments: {} } }) });
  const error = await mcp.json(); assert.equal(error.id, 7); assert.equal(error.result.isError, true); assert.match(error.result.content[0].text, /woc_lock_acquire/);
  const actor: Actor = { kind: 'agent', id: 'client:a', label: 'A' }, lock = await leases.take('a', actor, false, true);
  await rpc('ComputerService/Pointer'); assert.equal(calls, 2);
  await leases.release('a', actor, lock.epoch);
  assert.match(await (await rpc('ComputerService/Pointer')).text(), /WOC_LOCK_REQUIRED/); assert.equal(calls, 2);
});

test('native process streaming bypasses desktop lock without buffering or renewal', async t => {
  let close!: () => void;
  const upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/grpc-web+proto' }); res.write(frame); close = () => res.end(success); });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const leases = new ControlLeases(), adapter = { revoke: async () => {}, reset: async () => {}, grantHuman: async () => {} };
  await leases.ensure('a', 1, adapter);
  const owner = await leases.take('a', human);
  const client = { id: 'a', label: 'A', tokenHash: '', machines: ['a'] };
  const gateway = createControlGateway(() => ({ id: 'a', upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, rawToken: 'raw', viewToken: 'view', ensure: async () => { throw Error('must not initialize'); } }), leases, () => client);
  await new Promise<void>(r => gateway.listen(0, '127.0.0.1', r));
  t.after(() => { gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); });
  const response = await fetch(`http://127.0.0.1:${(gateway.address() as AddressInfo).port}/cua.env.v1.ProcessService/StartProcess`, { method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', authorization: 'Bearer stable' }, body: frame });
  const reader = response.body!.getReader(); const first = await reader.read(); assert.deepEqual(Buffer.from(first.value!), frame);
  assert.equal(leases.status('a', human).mine, true); assert.equal(leases.status('a').expiresAt, owner.expiresAt);
  close(); while (!(await reader.read()).done) { /* drain */ }
});

test('runtime replacement between ownership admission and dispatch invalidates the captured epoch', async t => {
  let forwarded = 0;
  const upstream = http.createServer((_req, res) => { forwarded++; res.end(success); });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const leases = new ControlLeases(), adapter = { revoke: async () => {}, reset: async () => {}, grantHuman: async () => {} };
  await leases.ensure('a', 1, adapter); await leases.take('a', { kind: 'agent', id: 'client:a', label: 'A' }, false, true);
  const gateway = createControlGateway(() => ({ id: 'a', upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, rawToken: 'raw', viewToken: 'view', ensure: () => leases.ensure('a', 2, adapter) }), leases,
    () => ({ id: 'a', label: 'A', tokenHash: '', machines: ['a'] }));
  await new Promise<void>(r => gateway.listen(0, '127.0.0.1', r));
  t.after(() => { gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); });
  const response = await fetch(`http://127.0.0.1:${(gateway.address() as AddressInfo).port}/cua.env.v1.ComputerService/Pointer`, { method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', authorization: 'Bearer stable' }, body: frame });
  assert.match(await response.text(), /WOC_CONTROL_BLOCKED/); assert.equal(forwarded, 0);
});
