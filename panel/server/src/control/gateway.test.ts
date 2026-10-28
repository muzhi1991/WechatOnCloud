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
  assert.ok((await f.post('ComputerService/Screenshot','invalid')).status>=400);assert.equal(f.ensures(),0);
  assert.equal((await f.post('ProcessService/Exec','view')).status,403);assert.equal(f.ensures(),0);
  const observed=await f.post('ComputerService/Screenshot','view');assert.equal(observed.status,200,await observed.text());
  assert.equal((await f.post('ComputerService/Keyboard','view')).status,403);assert.equal(forwarded,1);
});
test('disconnecting a mutation client retains its in-flight handover fence',async t=>{
  let finish!:()=>void, started!:()=>void;const dispatched=new Promise<void>(r=>started=r);
  const f=await fixture(t,(_req,res)=>{finish=()=>res.end(success);started();});await f.initialize();const grant=await f.leases.take('a',agent);
  const request=http.request(f.url+'/cua.env.v1.ComputerService/Keyboard',{method:'POST',headers:{'content-type':'application/grpc-web+proto',authorization:'Bearer '+grant.token}});
  request.on('error',()=>{});request.end(frame);await dispatched;request.destroy();
  const take=f.leases.take('a',human,true);assert.equal(f.leases.status('a').state,'handover');
  assert.equal((await f.post('ComputerService/Keyboard',grant.token!)).status,403);
  assert.equal(f.leases.status('a').inflight,1);finish();assert.equal((await take).mine,true);
});
test('upstream interruption leaves control faulted until explicit recovery',async t=>{
  const f=await fixture(t,(req)=>req.socket.destroy());await f.initialize();const grant=await f.leases.take('a',agent);
  assert.equal((await f.post('ComputerService/Keyboard',grant.token!)).status,503);
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
