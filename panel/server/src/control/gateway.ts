import http from 'node:http';
import httpProxy from 'http-proxy';
import { classifyRpc, classifyTool, grpcWebSucceeded } from './protocol.js';
import { readOnlyMediaRequest, rpcString } from './media-policy.js';
import { configuredClient, clientActor, clientCanAccess } from './clients.js';
import { ControlError, type ControlLeases } from './leases.js';

export interface GatewayTarget { id: string; upstream: string; viewToken: string; rawToken: string; ensure(): Promise<void> }
// Official Cua Auto transport falls back to gRPC-Web on HTTP/1-only gateways.
// Reads and native process/file/agent capabilities do not touch desktop locks.
// Only GUI mutations are fenced; nested driver calls are classified before dispatch.
export function createControlGateway(resolve: () => GatewayTarget | undefined, leases: ControlLeases, lookupClient = configuredClient) {
  const viewerTickets = new Map<string, { token: string; expires: number }>();
  const mediaTickets = new Map<string, number>();
  const proxy = httpProxy.createProxyServer({ ws: true });
  proxy.on('error', () => {});
  const server = http.createServer(async (req, res) => {
    let mcpRequest: any; let dispatchedWrite = false;
    const isMcp = req.url === '/mcp';
    const fail = (status: number, message: string) => {
      if (res.destroyed) return;
      if (isMcp) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: mcpRequest?.id ?? null, ...(mcpRequest?.method === 'tools/call'
          ? { result: { isError: true, content: [{ type: 'text', text: message }] } } : { error: { code: -32000, message } }) }));
        return;
      }
      if (String(req.headers['content-type']).startsWith('application/grpc-web')) {
        const trailer = Buffer.from(`grpc-status: ${status === 401 ? 16 : status === 403 ? 7 : 9}\r\ngrpc-message: ${encodeURIComponent(message)}\r\n`);
        const header = Buffer.alloc(5); header[0] = 128; header.writeUInt32BE(trailer.length, 1);
        res.writeHead(200, { 'content-type': 'application/grpc-web+proto', 'cache-control': 'no-store' });
        res.end(Buffer.concat([header, trailer]));
      } else { res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(message); }
    };
    try {
      const target = resolve(); if (!target) { fail(404, 'Desktop unavailable'); return; }
      if (req.method === 'GET' && req.url === '/health') { res.writeHead(204); res.end(); return; }
      const path = (req.url || '').split('?')[0];
      // Signed URLs are validated by spacesd against its original token. Do not
      // inject root authentication into these ticket-authorized requests.
      if (path === '/files' || path === '/viewer' || path.startsWith('/viewer/')) {
        proxy.web(req, res, { target: target.upstream }, () => { if (!res.headersSent) fail(502, 'Native transfer unavailable'); else res.destroy(); }); return;
      }
      if (req.method !== 'POST' || !(isMcp || String(req.headers['content-type']).startsWith('application/grpc-web'))) { fail(403, 'Use native Cua gRPC-Web or MCP transport'); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) { fail(413, 'Request too large'); return; } chunks.push(chunk); }
      const body = readOnlyMediaRequest(req.url || '', Buffer.concat(chunks));
      if (isMcp) mcpRequest = JSON.parse(body.toString());
      const kind = isMcp ? (mcpRequest.method === 'tools/call' ? classifyTool(mcpRequest.params?.name, mcpRequest.params?.arguments)
        : ['initialize', 'ping', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get', 'notifications/initialized'].includes(mcpRequest.method) ? 'read' : 'deny') : classifyRpc(req.url || '', body);
      if (kind === 'deny') { fail(403, 'WOC_UNSUPPORTED_OPERATION: operation has not been classified; no input was dispatched'); return; }
      const token = String(req.headers.authorization || req.headers['x-cua-env-authorization'] || '').replace(/^Bearer /, '');
      let lease: ReturnType<ControlLeases['agent']> | undefined;
      const viewer = viewerTickets.get(token);
      const validViewer = viewer && viewer.expires > Date.now() ? viewer : undefined;
      const client = lookupClient(validViewer?.token || token);
      const upstreamToken = validViewer ? token : target.rawToken;
      if (client) {
        if (!clientCanAccess(client, target.id)) { fail(403, 'WOC_MACHINE_NOT_FOUND'); return; }
        if (validViewer && kind === 'write') { fail(403, 'WOC_VIEW_ONLY: native gateway viewers are read-only; use original Cua GUI tools with the WOC lock, or the separately configured direct App connection'); return; }
        if (kind === 'write') lease = leases.client(target.id, clientActor(client));
      } else if (token !== target.viewToken || kind !== 'read') lease = leases.agent(target.id, token);
      // Validate runtime incarnation only after ownership admission. The final
      // write checks the captured epoch again after this asynchronous check.
      if (kind === 'write') await target.ensure();
      // Reads must never initialize/reset the desktop or renew a write lock.
      // Preparation happens on explicit acquisition, through the control API.
      const createsViewer = req.url === '/cua.env.v1.SystemService/CreateViewerTicket';
      const opensMedia = req.url === '/cua.env.v1.StreamService/OpenMedia';
      if (kind !== 'write' && !isMcp && !createsViewer && !opensMedia) {
        // Process output, file reads and watches must stream, not buffer until
        // exit or impose a desktop-action deadline on remote coding agents.
        const upstream = http.request(target.upstream + req.url, { method: 'POST', headers: {
          'content-type': String(req.headers['content-type']), 'content-length': body.length,
          'x-grpc-web': '1', authorization: `Bearer ${upstreamToken}`,
        } }, response => {
          clearTimeout(timer);
          res.writeHead(response.statusCode || 502, { 'content-type': String(response.headers['content-type'] || 'application/grpc-web+proto'), 'cache-control': 'no-store' });
          response.on('error', () => res.destroy()); response.pipe(res);
        });
        const timer = setTimeout(() => upstream.destroy(new Error('Native response timeout')), 150_000);
        res.on('close', () => { clearTimeout(timer); upstream.destroy(); });
        upstream.on('error', () => { clearTimeout(timer); if (res.headersSent) res.destroy(); else fail(503, 'WOC_UPSTREAM_UNAVAILABLE'); });
        upstream.end(body); return;
      }
      const forward = () => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        const upstream = http.request(target.upstream + req.url, { method: 'POST', headers: {
          'content-type': String(req.headers['content-type']), 'content-length': body.length,
          ...(isMcp ? { accept: 'application/json, text/event-stream', ...(req.headers['mcp-session-id'] ? { 'mcp-session-id': req.headers['mcp-session-id'] } : {}), ...(req.headers['mcp-protocol-version'] ? { 'mcp-protocol-version': req.headers['mcp-protocol-version'] } : {}) } : { 'x-grpc-web': '1' }), authorization: `Bearer ${upstreamToken}`,
        } }, response => {
          const chunks: Buffer[] = []; let size = 0;
          response.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) upstream.destroy(new Error('Response too large')); else chunks.push(chunk); });
          response.on('error', reject);
          response.on('end', () => resolve({ status: response.statusCode || 502, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        const timer = setTimeout(() => upstream.destroy(new Error('RPC completion unknown')), 150_000);
        upstream.on('close', () => clearTimeout(timer)); upstream.on('error', reject); dispatchedWrite = kind === 'write'; upstream.end(body);
      });
      const run = async () => {
        const result = await forward();
        if (kind === 'write' && (result.status !== 200 || !(isMcp ? result.body.length > 0 : grpcWebSucceeded(result.body)))) throw new Error('RPC completion was not successful; control recovery required');
        return result;
      };
      // Do not cancel a dispatched mutation when its client disconnects: retain
      // the in-flight fence until the backend replies or becomes uncertain.
      const result = kind === 'write' ? await leases.write(target.id, lease!.actor, lease!.epoch, run, req.url!.split('/').slice(-2).join('/')) : await run();
      if (result.status === 200 && grpcWebSucceeded(result.body)) {
        const now = Date.now();
        for (const [key, value] of viewerTickets) if (value.expires <= now) viewerTickets.delete(key);
        for (const [key, expiry] of mediaTickets) if (expiry <= now) mediaTickets.delete(key);
        if (createsViewer && client && !validViewer) {
          const ticket = rpcString(result.body, 1);
          if (ticket) { if (viewerTickets.size >= 1000) viewerTickets.delete(viewerTickets.keys().next().value!); viewerTickets.set(ticket, { token, expires: now + 86_400_000 }); }
        }
        if (opensMedia) {
          const ticket = rpcString(result.body, 2);
          if (ticket) { if (mediaTickets.size >= 1000) mediaTickets.delete(mediaTickets.keys().next().value!); mediaTickets.set(ticket, now + 600_000); }
        }
      }
      if (!res.destroyed) {
        if (result.headers['mcp-session-id']) res.setHeader('mcp-session-id', result.headers['mcp-session-id']);
        res.writeHead(result.status, { 'content-type': String(result.headers['content-type'] || 'application/grpc-web+proto'), 'cache-control': 'no-store' });
        res.end(result.body);
      }
    } catch (e) {
      const target = resolve();
      const code = dispatchedWrite ? 'WOC_ACTION_UNCERTAIN' : e instanceof ControlError ? e.code || 'WOC_CONTROL_BLOCKED' : 'WOC_INVALID_REQUEST';
      const tip = !dispatchedWrite && e instanceof ControlError
        ? `${code}: 本次操作未执行。${e.message}。请通过 WOC skill 调用 woc_lock_acquire(machine_id="${target?.id || ''}")；成功后重新观察再操作，用完 woc_lock_release。${leases.idleMs / 1000} 秒无 GUI 写自动释放。`
        : dispatchedWrite ? `${code}: 操作结果未知，请重新观察并检查控制状态，不要自动重放。` : `${code}: 请求无效，未执行操作。`;
      fail(e instanceof ControlError ? e.statusCode : 503, tip);
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const target = resolve(), path = (req.url || '').split('?')[0];
    if (!target || !['/media', '/tunnel', '/hotspot', '/volume'].includes(path)) { socket.destroy(); return; }
    if (path === '/media') {
      const ticket = new URL(req.url!, 'http://gateway').searchParams.get('ticket')
        || String(req.headers['sec-websocket-protocol'] || '').split(',').map(x => x.trim()).find(x => x.startsWith('cua.ticket.'))?.slice(11) || '';
      if ((mediaTickets.get(ticket) || 0) <= Date.now()) { socket.destroy(); return; }
    }
    // Native tickets, including expiry, remain verified upstream. These are
    // media/file/process transports, not GUI input RPCs.
    proxy.ws(req, socket, head, { target: target.upstream }, () => socket.destroy());
  });
  server.on('close', () => proxy.close());
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  // Cua probes HTTP/2 before falling back. Its reset must not crash the panel
  // after the HTTP/1 parser hands the socket to our clientError handler.
  server.on('connection', socket => socket.on('error', () => socket.destroy()));
  server.on('clientError', (_e, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  return server;
}
