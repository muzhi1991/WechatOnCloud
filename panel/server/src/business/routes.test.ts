import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import Fastify from 'fastify';
import { registerReadRoutes } from './routes.js';

test('read gateway: machine ACL, trusted caller, validation, JSON and authenticated files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'woc-read-route-'));
  const token = 'a'.repeat(48), serviceToken = 's'.repeat(48);
  const clientFile = join(dir, 'clients.json'), serviceFile = join(dir, 'service.token');
  await writeFile(clientFile, JSON.stringify([{ id: 'reader', label: 'Reader', tokenHash: createHash('sha256').update(token).digest('hex'), machines: ['allowed'] }]));
  await writeFile(serviceFile, serviceToken);
  const previous = process.env.WOC_CLIENTS_FILE; process.env.WOC_CLIENTS_FILE = clientFile;
  const handle = 'f'.repeat(48);
  let calls = 0, lastBody: any;
  const upstream = http.createServer(async (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${serviceToken}`);
    assert.equal(req.headers['x-woc-principal'], createHash('sha256').update('client:reader').digest('hex'));
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.method === 'GET') { res.end('synthetic-media'); return; }
    lastBody = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/extract' ? { exported: true, file_id: handle } : { sessions: [], freshness: 'checkpoint_only' }));
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const app = Fastify();
  registerReadRoutes(app, { exists: id => ['allowed', 'private'].includes(id),
    target: () => ({ url: `http://127.0.0.1:${(upstream.address() as any).port}`, tokenFile: serviceFile }) });
  const headers = { authorization: `Bearer ${token}`, 'x-woc-principal': 'forged' };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/integrations/wechat/allowed/sessions', payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/integrations/wechat/private/sessions', headers, payload: {} })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/integrations/wechat/missing/sessions', headers, payload: {} })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/integrations/wechat/allowed/history', headers, payload: { limit: 501 } })).statusCode, 400);
    assert.equal(calls, 0);
    const response = await app.inject({ method: 'POST', url: '/api/integrations/wechat/allowed/sessions', headers, payload: { limit: 5 } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().freshness, 'checkpoint_only');
    assert.deepEqual(lastBody, { limit: 5 });
    const exported = await app.inject({ method: 'POST', url: '/api/integrations/wechat/allowed/extract', headers, payload: { attachment_id: 'example' } });
    assert.equal(exported.statusCode, 200);
    const url = exported.json().download_url;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const file = await app.inject({ url, headers });
    assert.equal(file.statusCode, 200); assert.equal(file.body, 'synthetic-media');
    assert.equal(file.headers['content-type'], 'application/octet-stream');
    assert.equal(file.headers['cache-control'], 'no-store');
    // Revoking the identity affects subsequent queries and downloads.
    await writeFile(clientFile, '[]');
    assert.equal((await app.inject({ url, headers })).statusCode, 401);
  } finally {
    await app.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r()));
    if (previous === undefined) delete process.env.WOC_CLIENTS_FILE; else process.env.WOC_CLIENTS_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('large HTTP/1.0 file reaches a slow client without crashing or truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'woc-stream-test-'));
  const token = 'z'.repeat(48), previous = process.env.WOC_CLIENTS_FILE;
  await writeFile(join(dir, 'clients'), JSON.stringify([{ id: 'reader', label: 'Reader', tokenHash: createHash('sha256').update(token).digest('hex'), machines: ['allowed'] }]));
  await writeFile(join(dir, 'service'), 's'.repeat(48));
  process.env.WOC_CLIENTS_FILE = join(dir, 'clients');
  const payload = Buffer.alloc(8 * 1024 * 1024, 97);
  const upstream = net.createServer(socket => {
    socket.once('data', () => {
      socket.end(Buffer.concat([Buffer.from(`HTTP/1.0 200 OK\r\nContent-Length: ${payload.length}\r\nContent-Type: application/octet-stream\r\n\r\n`), payload]));
    });
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const app = Fastify();
  registerReadRoutes(app, { exists: () => true, target: () => ({ url: `http://127.0.0.1:${(upstream.address() as any).port}`, tokenFile: join(dir, 'service') }) });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const received = await new Promise<Buffer>((resolve, reject) => {
      const request = http.get(address + '/api/integrations/wechat/allowed/files/' + 'f'.repeat(48), { headers: { authorization: `Bearer ${token}` } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => { chunks.push(chunk); response.pause(); setTimeout(() => response.resume(), 10); });
        response.on('error', reject);
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });
      request.on('error', reject);
      request.setTimeout(15000, () => request.destroy(new Error('stream timed out')));
    });
    assert.deepEqual(received, payload);
  } finally {
    await app.close(); await new Promise<void>(r => upstream.close(() => r()));
    if (previous === undefined) delete process.env.WOC_CLIENTS_FILE; else process.env.WOC_CLIENTS_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
