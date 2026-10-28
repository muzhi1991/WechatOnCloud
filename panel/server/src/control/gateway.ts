import http from 'node:http';
import { classifyRpc, grpcWebSucceeded } from './protocol.js';
import { ControlError, type ControlLeases } from './leases.js';

export interface GatewayTarget { id: string; upstream: string; viewToken: string; rawToken: string; ensure(): Promise<void> }
// Official Cua Auto transport falls back to gRPC-Web on HTTP/1-only gateways.
// No /mcp, viewer tickets, process/shell, tunnel, file writes, or replay routes.
export function createControlGateway(resolve: () => GatewayTarget | undefined, leases: ControlLeases) {
  const server = http.createServer(async (req, res) => {
    const fail = (status: number, message: string) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(message); } };
    try {
      const target = resolve(); if (!target) { fail(404, 'Desktop unavailable'); return; }
      if (req.method === 'GET' && req.url === '/health') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/grpc-web')) { fail(403, 'Only managed unary gRPC-Web is supported'); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) { fail(413, 'Request too large'); return; } chunks.push(chunk); }
      const body = Buffer.concat(chunks); const kind = classifyRpc(req.url || '', body);
      if (kind === 'deny') { fail(403, 'RPC is outside the managed desktop allowlist'); return; }
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      let lease: ReturnType<ControlLeases['agent']> | undefined;
      if (token !== target.viewToken || kind === 'write') lease = leases.agent(target.id, token);
      // Only authenticated clients may initialize (and fence) the desktop.
      await target.ensure();
      const forward = () => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        const upstream = http.request(target.upstream + req.url, { method: 'POST', headers: {
          'content-type': String(req.headers['content-type']), 'content-length': body.length,
          'x-grpc-web': '1', authorization: `Bearer ${target.rawToken}`,
        } }, response => {
          const chunks: Buffer[] = []; let size = 0;
          response.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) upstream.destroy(new Error('Response too large')); else chunks.push(chunk); });
          response.on('error', reject);
          response.on('end', () => resolve({ status: response.statusCode || 502, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        const timer = setTimeout(() => upstream.destroy(new Error('RPC completion unknown')), 30_000);
        upstream.on('close', () => clearTimeout(timer)); upstream.on('error', reject); upstream.end(body);
      });
      const run = async () => {
        const result = await forward();
        if (kind === 'write' && (result.status !== 200 || !grpcWebSucceeded(result.body))) throw new Error('RPC completion was not successful; control recovery required');
        return result;
      };
      // Do not cancel a dispatched mutation when its client disconnects: retain
      // the in-flight fence until the backend replies or becomes uncertain.
      const result = kind === 'write' ? await leases.write(target.id, lease!.actor, lease!.epoch, run) : await run();
      if (!res.destroyed) {
        res.writeHead(result.status, { 'content-type': String(result.headers['content-type'] || 'application/grpc-web+proto'), 'cache-control': 'no-store' });
        res.end(result.body);
      }
    } catch (e) { fail(e instanceof ControlError ? e.statusCode : 503, e instanceof ControlError ? e.message : 'Desktop request failed; inspect control status'); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  // Cua probes HTTP/2 before falling back. Its reset must not crash the panel
  // after the HTTP/1 parser hands the socket to our clientError handler.
  server.on('connection', socket => socket.on('error', () => socket.destroy()));
  server.on('clientError', (_e, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  return server;
}
