import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerUiRoutes } from './ui-routes.js';
import { ControlLeases } from '../control/leases.js';

test('application writes use the existing lock; errors preserve prerequisites and stale periods do not dispatch', async () => {
  const dir=await mkdtemp(join(tmpdir(),'woc-ui-')); const old=process.env.WOC_CLIENTS_FILE;
  const token='u'.repeat(48);const clients=join(dir,'clients');const service=join(dir,'service');
  await writeFile(clients,JSON.stringify([{id:'test',label:'Test',tokenHash:createHash('sha256').update(token).digest('hex'),machines:['one']}]));
  await writeFile(service,'s'.repeat(48));process.env.WOC_CLIENTS_FILE=clients;
  let calls=0, epoch='', failureStatus=409;
  const upstream=http.createServer((req,res)=>{calls++;epoch=String(req.headers['x-woc-control-epoch']||'');req.resume();res.setHeader('content-type','application/json');res.statusCode=(req.url?.endsWith('/ui_state') || req.url?.endsWith('/browser_state'))?200:failureStatus;res.end(JSON.stringify(res.statusCode===200?{page:'contacts'}:{ok:false,code:'WOC_WRONG_PAGE',execution:'not_started',precondition:{page:'chat'}}));});
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  const leases=new ControlLeases();const adapter={revoke:async()=>{},reset:async()=>{},grantHuman:async()=>{}};
  await leases.ensure('one',1,adapter);
  const app=Fastify();registerUiRoutes(app,{exists:()=>true,leases,ensure:async()=>{},target:()=>({url:`http://127.0.0.1:${(upstream.address() as any).port}`,tokenFile:service})});
  const headers={authorization:`Bearer ${token}`};
  const call=(op:string,payload={},extra={})=>app.inject({method:'POST',url:`/api/integrations/wechat/one/${op}`,headers:{...headers,...extra},payload});
  try {
    assert.equal((await call('ui_state')).statusCode,200);assert.equal(epoch,'');
    let before=calls;const denied=await call('navigate',{page:'contacts'});
    assert.equal(denied.json().code,'WOC_LOCK_REQUIRED');assert.equal(calls,before);
    assert.equal((await call('browser_state')).statusCode,200);assert.equal(epoch,'');
    const browserBefore=calls;
    assert.equal((await call('browser_open_url',{window_ref:'a'.repeat(32),url:'https://linux.weixin.qq.com'})).json().code,'WOC_LOCK_REQUIRED');
    assert.equal(calls,browserBefore);before=calls;
    const actor={kind:'agent' as const,id:'client:test',label:'Test'};
    // Use the same identity construction as actual client routes.
    const { clientActor }=await import('../control/clients.js');
    const realActor=clientActor({id:'test',label:'Test',machines:['one']} as any);
    const lease=await leases.take('one',realActor,false,true);
    const stale=await call('navigate',{page:'contacts'},{'x-woc-expected-epoch':'0'.repeat(36)});
    assert.equal(stale.json().code,'WOC_LOCK_EXPIRED');assert.equal(calls,before);
    const result=await call('navigate',{page:'contacts'},{'x-woc-expected-epoch':lease.epoch});
    assert.equal(result.statusCode,409);assert.deepEqual(result.json().precondition,{page:'chat'});assert.equal(epoch,lease.epoch);
    assert.equal(leases.status('one',realActor).mine,true);assert.equal(leases.status('one').state,'agent');
    const browser=await call('browser_open_url',{window_ref:'a'.repeat(32),url:'https://linux.weixin.qq.com'},{'x-woc-expected-epoch':lease.epoch});
    assert.equal(browser.statusCode,409);assert.equal(epoch,lease.epoch);
    assert.deepEqual(browser.json().precondition,{page:'chat'});
    failureStatus=503;
    const unavailable=await call('navigate',{page:'contacts'});
    assert.equal(unavailable.statusCode,503);assert.equal(unavailable.json().execution,'not_started');
    assert.deepEqual(unavailable.json().precondition,{page:'chat'});assert.equal(leases.status('one').state,'agent');
    assert.equal((await call('navigate',{page:'contacts',shell:'bad'})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/api/integrations/wechat/two/ui_state',headers,payload:{}})).statusCode,404);
  } finally {await app.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));if(old===undefined)delete process.env.WOC_CLIENTS_FILE;else process.env.WOC_CLIENTS_FILE=old;await rm(dir,{recursive:true,force:true});}
});
