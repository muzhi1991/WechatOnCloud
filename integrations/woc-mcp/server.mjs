import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const config = JSON.parse(readFileSync(process.argv[2] || process.env.WOC_CLIENT_CONFIG, 'utf8'));
const names = { woc_machines_list: 'machines', woc_lock_status: 'status', woc_lock_acquire: 'acquire', woc_lock_release: 'release' };
const descriptions = {
  woc_machines_list: 'List WOC machines accessible to this authenticated client, with original Cua endpoints.',
  woc_lock_status: 'Read desktop write-lock state. Does not acquire or renew it.',
  woc_lock_acquire: 'Acquire this client’s GUI write lock. Use original Cua tools afterwards with unchanged credentials. Idle GUI timeout releases automatically; reads do not renew.',
  woc_lock_release: 'Release the lock using lock_id returned by acquire. Does not release a newer or another client’s lock.',
};
const tools = Object.keys(names).map(name => ({ name, description: descriptions[name],
  inputSchema: { type: 'object', properties: name === 'woc_machines_list' ? {} : {
    machine_id: { type: 'string' }, ...(name === 'woc_lock_release' ? { lock_id: { type: 'string' } } : {}),
  }, required: name === 'woc_machines_list' ? [] : name === 'woc_lock_release' ? ['machine_id', 'lock_id'] : ['machine_id'], additionalProperties: false },
  annotations: { readOnlyHint: ['woc_machines_list', 'woc_lock_status'].includes(name), destructiveHint: false, openWorldHint: false },
}));
async function dispatch(request) {
  switch (request.method) {
    case 'initialize': return { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'woc-control', version: '0.1.0' } };
    case 'ping': return {};
    case 'tools/list': return { tools };
    case 'tools/call': {
      const name = request.params?.name, args = request.params?.arguments || {};
      if (!Object.hasOwn(names, name)) throw new Error('Unknown WOC tool');
      if (name !== 'woc_machines_list' && typeof args.machine_id !== 'string') throw new Error('machine_id is required');
      const token = readFileSync(config.tokenFile, 'utf8').trim();
      const response = await fetch(`${config.panelUrl.replace(/\/$/, '')}/api/integrations/woc/${names[name]}`, {
        method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(args), signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json();
      return { isError: !response.ok, content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    default: throw new Error('Unknown MCP method');
  }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let request;
  try { request = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }) + '\n'); continue; }
  if (request.id === undefined) continue;
  try { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: await dispatch(request) }) + '\n'); }
  catch (e) {
    const message = e instanceof Error ? e.message : 'WOC request failed';
    const output = request.method === 'tools/call' ? { result: { isError: true, content: [{ type: 'text', text: message }] } }
      : { error: { code: -32601, message } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...output }) + '\n');
  }
}
