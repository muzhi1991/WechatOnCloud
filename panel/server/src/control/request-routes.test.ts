import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ControlLeases } from './leases.js';
import { ControlRequests } from './requests.js';
import { humanActor } from './actors.js';
import { registerControlRequestRoutes } from './request-routes.js';

test('only holder may respond, force is explicitly admin-only and machine access is required', async()=>{
  const l=new ControlLeases();await l.ensure('machine',1,{revoke:async()=>{},reset:async()=>{},grantHuman:async()=>{}});
  const actors=Object.fromEntries(['owner','requester','admin'].map(id=>[id,humanActor({id,username:id})]));
  const requests=new ControlRequests(l,()=>true);const app=Fastify();
  registerControlRequestRoutes(app,{leases:l,requests,ensure:async()=>{},authorize(req,reply,machine){
    const user=String(req.headers['test-user']||'');
    if(!actors[user]){reply.code(401).send({error:'login required'});return;}
    if(machine!=='machine'){reply.code(403).send({error:'no access'});return;}
    return {actor:actors[user],admin:user==='admin'};
  }});
  const call=(user:string,action:string,body?:object,epoch='')=>app.inject({method:'POST',url:`/api/instances/machine/control/${action}`,headers:{'test-user':user,'x-woc-epoch':epoch},payload:body});
  try{
    const owner=await requests.request('machine',actors.owner);const pending=await requests.request('machine',actors.requester);
    assert.equal((await call('requester','force')).statusCode,403);
    assert.equal(l.status('machine',actors.owner).mine,true);
    assert.equal((await call('admin','respond',{request_id:pending.request!.id,approve:true},owner.epoch)).statusCode,403);
    assert.equal((await call('owner','respond',{request_id:pending.request!.id,approve:'yes'},owner.epoch)).statusCode,400);
    assert.equal((await call('requester','respond',{request_id:pending.request!.id,approve:true},owner.epoch)).statusCode,403);
    assert.equal((await call('owner','respond',{request_id:pending.request!.id,approve:true},owner.epoch)).statusCode,200);
    assert.equal(l.status('machine',actors.requester).mine,true);
    assert.equal((await call('owner','respond',{request_id:pending.request!.id,approve:true},owner.epoch)).statusCode,403);
    assert.equal((await call('admin','force')).statusCode,200);
    assert.equal(l.status('machine',actors.admin).mine,true);
    assert.equal((await call('','force')).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/instances/other/control/force',headers:{'test-user':'admin'}})).statusCode,403);
  }finally{await app.close();}
});
