import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { operations, schema } from '../../panel/server/src/business/contract.mjs';
import { uiOperations, uiSchema } from '../../panel/server/src/business/ui-contract.mjs';

const config = JSON.parse(readFileSync(process.argv[2] || process.env.WOC_CLIENT_CONFIG, 'utf8'));
const base = new URL(config.panelUrl);
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw Error('Invalid panel URL');
const pollMs = config.notificationIntervalMs ?? 5000;
if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 300000) throw Error('notificationIntervalMs must be 1000..300000');
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
for (const [op, spec] of Object.entries(operations)) {
  if (op === 'revision') continue;
  tools.push({ name: `woc_wechat_${op}`, description: spec.description, inputSchema: schema(op, true),
    annotations: { readOnlyHint: op !== 'extract', destructiveHint: false, openWorldHint: false } });
}
for (const [op, spec] of Object.entries(uiOperations)) {
  tools.push({ name: `woc_wechat_${op}`, description: spec.description, inputSchema: uiSchema(op, true),
    annotations: { readOnlyHint: !!spec.read, destructiveHint: !spec.read, openWorldHint: !spec.read } });
}
class HttpFailure extends Error {
  constructor(result) { super(`${result.code || 'WOC_REQUEST_FAILED'}: ${result.error || 'Request failed'}`); this.result = result; }
}
async function call(path, args = {}, extraHeaders = {}) {
  const token = readFileSync(config.tokenFile, 'utf8').trim();
  const response = await fetch(new URL(path, base), {
    method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(args), signal: AbortSignal.timeout(110_000),
  });
  const result = await response.json();
  if (!response.ok) throw new HttpFailure(result);
  return result;
}
const machineId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw Error('Invalid machine_id');
  return value;
};
const query = (id, op, args = {}) => call(`/api/integrations/wechat/${machineId(id)}/${op}`, args);
const uriFor = id => `wechat://${machineId(id)}/messages`;
const parseUri = uri => {
  const match = /^wechat:\/\/([a-zA-Z0-9_-]{1,128})\/messages$/.exec(uri);
  if (!match) throw Error('Unsupported resource URI');
  return match[1];
};
const server = new Server({ name: 'woc-control', version: '0.2.0' }, {
  capabilities: { tools: {}, resources: { subscribe: true } },
  instructions: 'WeChat queries use local checkpoint data, can lag the GUI, and never acquire a GUI write lock. Resource notifications are change hints, not guaranteed per-message delivery or automatic model wakeups. Re-query after reconnect and maintain your own processing progress.',
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const name = request.params.name, args = request.params.arguments || {};
    let result;
    if (Object.hasOwn(names, name)) {
      if (name !== 'woc_machines_list') machineId(args.machine_id);
      result = await call(`/api/integrations/woc/${names[name]}`, args);
    } else if (name.startsWith('woc_wechat_') && Object.hasOwn(uiOperations, name.slice(11))) {
      const { machine_id, lock_id, ...body } = args;
      result = await call(`/api/integrations/wechat/${machineId(machine_id)}/${name.slice(11)}`, body,
        lock_id ? { 'x-woc-expected-epoch': lock_id } : {});
    } else {
      const op = name.replace(/^woc_wechat_/, '');
      if (!name.startsWith('woc_wechat_') || op === 'revision' || !Object.hasOwn(operations, op)) throw Error('Unknown WOC tool');
      const { machine_id, ...body } = args;
      result = await query(machine_id, op, body);
      if (op === 'extract' && result.download_url) {
        result.download_url = new URL(result.download_url, base).href;
        result.download_auth = 'Use the same WOC client Bearer credential; never include it in the URL or a model prompt.';
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) {
    if (e instanceof HttpFailure) return { isError: true, content: [{ type: 'text', text: JSON.stringify(e.result) }], structuredContent: e.result };
    return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : 'WOC request failed' }] };
  }
});
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const result = await call('/api/integrations/woc/machines');
  const ready = await Promise.all(result.machines.slice(0, 64).map(async m => {
    try {
      const token = readFileSync(config.tokenFile, 'utf8').trim();
      const r = await fetch(new URL(`/api/integrations/wechat/${machineId(m.id)}/health`, base), {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return null;
      return { uri: uriFor(m.id), name: `${m.name}: WeChat messages`,
        description: 'Local database change hint; query recent messages and deduplicate after notification.', mimeType: 'application/json' };
    } catch { return null; }
  }));
  return { resources: ready.filter(Boolean) };
});
server.setRequestHandler(ReadResourceRequestSchema, async request => ({ contents: [{ uri: request.params.uri,
  mimeType: 'application/json', text: JSON.stringify(await query(parseUri(request.params.uri), 'sessions', { limit: 20 })) }] }));
// Only ephemeral per-connection revisions. No event sequence, queue or consumer offsets.
const subscriptions = new Map();
server.setRequestHandler(SubscribeRequestSchema, async request => {
  const uri = request.params.uri, id = parseUri(uri);
  if (subscriptions.size >= 64 && !subscriptions.has(uri)) throw Error('Subscription limit reached');
  const revision = await query(id, 'revision');
  subscriptions.set(uri, { id, revision: revision.revision });
  return {};
});
server.setRequestHandler(UnsubscribeRequestSchema, async request => { subscriptions.delete(request.params.uri); return {}; });
let checking = false;
const timer = setInterval(async () => {
  if (checking) return;
  checking = true;
  try {
    for (const [uri, entry] of subscriptions) {
      try {
        const current = await query(entry.id, 'revision');
        if (subscriptions.get(uri) !== entry) continue;
        if (current.revision !== entry.revision) {
          await server.sendResourceUpdated({ uri });
          entry.revision = current.revision;
        }
      } catch (error) {
        if (/WOC_UNAUTHORIZED|WOC_MACHINE_NOT_FOUND/.test(String(error))) subscriptions.delete(uri);
      }
    }
  } finally { checking = false; }
}, pollMs);
timer.unref();
server.onclose = () => { clearInterval(timer); subscriptions.clear(); };
await server.connect(new StdioServerTransport());
