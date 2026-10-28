#!/usr/bin/env node
// Managed Cua CLI: credentials stay in this trusted Master process and private
// lease files. Every GUI call still uses the official cua spacesd client.
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { curlRequest } from '../cua-master-sync/sync.mjs';
const execute = promisify(execFile);
async function main() {
  const [configPath, command, id, method, json = '{}'] = process.argv.slice(2);
  if (!configPath || !['acquire','renew','call','release','status'].includes(command) || !/^[a-f0-9]{10}$/.test(id || '')) throw Error('Usage: node agent.mjs CONFIG acquire|renew|call|release|status INSTANCE [Service/Method] [JSON]');
  const config=JSON.parse(readFileSync(configPath,'utf8'));
  const directory=config.leaseDir;
  mkdirSync(directory,{recursive:true,mode:0o700});
  const file=join(directory,id+'.json');
  let lease;try{lease=JSON.parse(readFileSync(file,'utf8'));}catch{}
  const clientId=lease?.clientId || randomUUID();
  const request=async(operation,body={})=>{
    const token=readFileSync(config.agentTokenFile,'utf8').trim();
    const url=`${config.panelUrl.replace(/\/$/,'')}/api/integrations/control/${id}/${operation}`;
    const data={clientId,label:config.label || 'Cua Agent',...body};
    if(config.curlBinary)return curlRequest(url,token,data,config.curlBinary);
    const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(15_000),redirect:'error'});
    if(!response.ok)throw Error(`Control request HTTP ${response.status}`);
    return response.json();
  };
  const save=value=>{writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(file+'.tmp',file);};
  if(command==='acquire'){
    for(let tries=0;tries<20;tries++){
      const state=await request('acquire');
      if(state.mine&&state.token){save({...state,clientId});const {token,...publicState}=state;console.log(JSON.stringify(publicState));return;}
      if(state.state==='faulted')throw Error('Desktop needs explicit administrator recovery');
      await new Promise(r=>setTimeout(r,1000));
    }
    throw Error('Handover still pending; no input was sent');
  }
  if(command==='status'){console.log(JSON.stringify(await request('status')));return;}
  if(!lease)throw Error('No local lease; acquire control first');
  if(command==='renew'){console.log(JSON.stringify(await request('renew',{epoch:lease.epoch})));return;}
  if(command==='release'){const state=await request('release',{epoch:lease.epoch});unlinkSync(file);console.log(JSON.stringify(state));return;}
  if(!/^[A-Za-z]+Service\/[A-Za-z]+$/.test(method || ''))throw Error('Expected Service/Method');
  JSON.parse(json);
  await request('renew',{epoch:lease.epoch});
  let lost=false, renewing=false;
  const timer=setInterval(async()=>{if(renewing||lost)return;renewing=true;try{await request('renew',{epoch:lease.epoch});}catch{lost=true;}finally{renewing=false;}},5000);
  try {
    const {stdout}=await execute(config.cuaBinary,['spacesd','call','--json',lease.endpoint,method,json],{
      env:{...process.env,CUA_ENV_TOKEN:lease.token},timeout:40_000,maxBuffer:64*1024*1024,
    });
    process.stdout.write(stdout);
    if(lost){console.error('Control changed while this action was running. Inspect the desktop; do not replay it.');process.exitCode=2;}
  } catch { throw Error('Cua action failed. Inspect control status and the desktop; no automatic replay was attempted.'); }
  finally {clearInterval(timer);}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
