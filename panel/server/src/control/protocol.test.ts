import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRpc, classifyTool, grpcWebSucceeded } from './protocol.js';
function frame(payload: Buffer, flag=0) {const header=Buffer.alloc(5);header[0]=flag;header.writeUInt32BE(payload.length,1);return Buffer.concat([header,payload]);}
const tool=(name:string)=>frame(Buffer.concat([Buffer.from([10,name.length]),Buffer.from(name)]));
test('Cua gRPC-Web allowlist separates observing from writing and rejects bypass routes',()=>{
 assert.equal(classifyRpc('/cua.env.v1.DriverService/CallTool',tool('get_desktop_state')),'read');
 assert.equal(classifyRpc('/cua.env.v1.DriverService/CallTool',tool('type_text')),'write');
 for(const name of ['run_script','replay_trajectory','set_config','browser_prepare'])assert.equal(classifyRpc('/cua.env.v1.DriverService/CallTool',tool(name)),'write');
 for(const path of ['/mcp','/viewer','/cua.env.v1.ProcessService/Exec','/cua.env.v1.ComputerService/Keyboard?foo'])assert.equal(classifyRpc(path,frame(Buffer.alloc(0))),'deny');
 assert.equal(classifyRpc('/cua.env.v1.ComputerService/Keyboard',frame(Buffer.alloc(0))),'write');
 const duplicate=frame(Buffer.from([10,1,97,10,1,98]));assert.throws(()=>classifyRpc('/cua.env.v1.DriverService/CallTool',duplicate),/Duplicate/);
 const compressed=tool('click');compressed[0]=1;assert.throws(()=>classifyRpc('/cua.env.v1.DriverService/CallTool',compressed));
});
test('mutations require explicit successful gRPC trailers, not merely HTTP 200',()=>{
 const success=frame(Buffer.from('grpc-status: 0\r\n'),128);
 assert.equal(grpcWebSucceeded(success),true);
 assert.equal(grpcWebSucceeded(frame(Buffer.from('grpc-status: 4\r\n'),128)),false);
 assert.equal(grpcWebSucceeded(frame(Buffer.alloc(0))),false);
 assert.equal(grpcWebSucceeded(success.subarray(0,success.length-1)),false);
});


test('nested tools and legacy browser actions use their actual side effects', () => {
 assert.equal(classifyTool('page', { action: 'get_text' }), 'read');
 assert.equal(classifyTool('page', { action: 'query_dom' }), 'read');
 assert.equal(classifyTool('page', { action: 'execute_javascript' }), 'write');
 assert.equal(classifyTool('run_steps', { steps: [{ tool: 'get_window_state', args: {} }] }), 'read');
 assert.equal(classifyTool('run_steps', { steps: [{ click: { x: 1, y: 2 } }] }), 'write');
 assert.equal(classifyTool('run_steps', { steps: [{ tool: 'future_tool' }] }), 'deny');
 for (const service of ['ProcessService/StartProcess', 'ProcessService/SendInput', 'FilesystemService/ReadFile', 'FilesystemService/UploadChunk'])
   assert.equal(classifyRpc('/cua.env.v1.' + service, frame(Buffer.alloc(0))), 'bypass');
 assert.equal(classifyTool('get_browser_state'), 'read');
 assert.equal(classifyTool('start_session'), 'bypass');
});

test('every tool in the deployed 63-tool driver contract has an explicit policy', async () => {
 const { readFileSync } = await import('node:fs');
 const contract = JSON.parse(readFileSync(new URL('./driver-contract.json', import.meta.url), 'utf8'));
 assert.equal(contract.tools.length, 63);
 for (const name of contract.tools) assert.notEqual(classifyTool(name, name === 'page' ? { action: 'get_text' } : name === 'run_steps' ? { steps: [{ tool: 'click', args: {} }] } : {}), 'deny', name);
});
