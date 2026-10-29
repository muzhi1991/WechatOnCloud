#!/usr/bin/env node
// Real control-plane and video-plane checks; no GUI input, no credential output.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [endpoint,tokenFile,cuaBinary]=process.argv.slice(2);
if(!endpoint||!tokenFile||!cuaBinary)throw Error('Usage: verify.mjs ENDPOINT TOKEN_FILE CUA_BINARY');
const token=readFileSync(tokenFile,'utf8').trim();
const rpc=(method,body={})=>{
 try{return JSON.parse(execFileSync(cuaBinary,['spacesd','call','--json',endpoint,method,JSON.stringify(body)],{env:{...process.env,CUA_ENV_TOKEN:token},encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']}));}
 catch{throw Error('RPC failed: '+method);}
};
const denied=await fetch(endpoint+'/cua.env.v1.ComputerService/Screenshot',{method:'POST',headers:{'content-type':'application/grpc-web+proto','x-grpc-web':'1'},body:Buffer.alloc(5),signal:AbortSignal.timeout(10000)});
const raw=Buffer.from(await denied.arrayBuffer());
assert(denied.status===401||denied.status===403||denied.headers.get('grpc-status')==='16'||raw.includes(Buffer.from('grpc-status: 16')), 'Unauthenticated Screenshot must be denied');
assert.equal(rpc('SystemService/Health').status,'HEALTH_STATUS_SERVING');
const t=rpc('StreamService/OpenMedia',{target:{displayId:'0'},codecs:['MEDIA_CODEC_H264'],maxFps:5});
let socket,frames=0,bytes=0;
try{
 assert.equal(t.codec,'MEDIA_CODEC_H264');
 const url=new URL(t.wsPath,endpoint);url.protocol=url.protocol==='https:'?'wss:':'ws:';
 await new Promise((resolve,reject)=>{
  socket=new WebSocket(url);socket.binaryType='arraybuffer';
  const timer=setTimeout(()=>reject(Error('Media did not arrive')),15000);
  socket.onmessage=event=>{if(event.data instanceof ArrayBuffer){frames++;bytes+=event.data.byteLength;}if(frames>=3&&bytes>256){clearTimeout(timer);resolve();}};
  socket.onerror=()=>{clearTimeout(timer);reject(Error('Media socket failed'));};
  socket.onclose=()=>{clearTimeout(timer);if(frames<3||bytes<=256)reject(Error('Media socket closed early'));};
 });
 console.log(JSON.stringify({health:'serving',unauthenticated:'denied',codec:t.codec,binaryMessages:frames,bytes,geometry:t.geometry?.frameSize}));
}finally{
 socket?.close();
 rpc('StreamService/CloseMedia',{mediaSessionId:t.mediaSessionId});
}
