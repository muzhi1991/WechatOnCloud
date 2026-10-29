import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { configuredClient, clientCanAccess } from '../control/clients.js';
import { operations, schema } from './contract.mjs';

export interface ReadTarget { url: string; tokenFile: string }
export function configuredReadTarget(id: string): ReadTarget | undefined {
  if (!process.env.WOC_READ_TARGETS_FILE) return;
  try {
    const target = JSON.parse(readFileSync(process.env.WOC_READ_TARGETS_FILE, 'utf8'))[id];
    if (!target || typeof target.url !== 'string' || typeof target.tokenFile !== 'string') return;
    const url = new URL(target.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return;
    return { url: url.origin, tokenFile: target.tokenFile };
  } catch { return; }
}

export function registerReadRoutes(app: FastifyInstance, dependencies: {
  exists(id: string): boolean;
  target?(id: string): ReadTarget | undefined;
  // Optional existing web-session identity; returns only after the instance ACL passes.
  webActor?(req: FastifyRequest, id: string): string | undefined;
}) {
  const targetFor = dependencies.target || configuredReadTarget;
  async function authorized(req: FastifyRequest, reply: any) {
    reply.header('cache-control', 'no-store');
    const id = (req.params as any).machine;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const client = configuredClient(bearer);
    const web = !req.headers.authorization ? dependencies.webActor?.(req, id) : undefined;
    if (!client && !web) { reply.code(401).send({ code: 'WOC_UNAUTHORIZED', error: 'Authentication required' }); return; }
    if (!dependencies.exists(id) || (client && !clientCanAccess(client, id))) {
      reply.code(404).send({ code: 'WOC_MACHINE_NOT_FOUND', error: 'Machine unavailable' }); return;
    }
    const target = targetFor(id);
    if (!target) { reply.code(503).send({ code: 'WOC_READ_NOT_CONFIGURED', error: 'Read service is not configured for this machine' }); return; }
    let token: string;
    try { token = readFileSync(target.tokenFile, 'utf8').trim(); if (token.length < 32) throw Error(); }
    catch { reply.code(503).send({ code: 'WOC_READ_NOT_CONFIGURED', error: 'Read service credential unavailable' }); return; }
    const principal = createHash('sha256').update(client ? `client:${client.id}` : `web:${web}`).digest('hex');
    return { target, headers: { authorization: `Bearer ${token}`, 'x-woc-principal': principal } };
  }
  for (const op of Object.keys(operations)) {
    app.post(`/api/integrations/wechat/:machine/${op}`, { schema: { body: schema(op) } }, async (req, reply) => {
      const auth = await authorized(req, reply); if (!auth) return;
      try {
        const response = await fetch(`${auth.target.url}/v1/${op}`, {
          method: 'POST', redirect: 'error', headers: { ...auth.headers, 'content-type': 'application/json' },
          body: JSON.stringify(req.body), signal: AbortSignal.timeout(100_000),
        });
        const data = await response.json() as any;
        if (op === 'extract' && response.ok && data.exported === true) {
          if (!/^[a-f0-9]{48}$/.test(data.file_id)) throw Error('Invalid export handle');
          data.download_url = `/api/integrations/wechat/${encodeURIComponent((req.params as any).machine)}/files/${data.file_id}`;
        }
        return reply.code(response.status).send(data);
      } catch {
        return reply.code(503).send({ code: 'WOC_READ_UNAVAILABLE', error: 'Read service unavailable; no GUI operation was performed' });
      }
    });
  }
  app.get('/api/integrations/wechat/:machine/files/:file', async (req, reply) => {
    const auth = await authorized(req, reply); if (!auth) return;
    const file = (req.params as any).file;
    if (!/^[a-f0-9]{48}$/.test(file)) return reply.code(404).send({ code: 'WOC_FILE_NOT_FOUND' });
    try {
      // Native streams handle HTTP/1.0 EOF under downstream backpressure. Node's
      // bundled fetch/undici can assert in Parser.finish for this exact pattern.
      const url = new URL(`${auth.target.url}/v1/files/${file}`);
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).get(url, {
          headers: auth.headers, signal: AbortSignal.timeout(120_000),
        }, resolve);
        request.once('error', reject);
      });
      if (response.statusCode !== 200) {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of response) {
          size += chunk.length; if (size > 65536) { response.destroy(); throw Error(); }
          chunks.push(Buffer.from(chunk));
        }
        return reply.code(response.statusCode || 502).send(JSON.parse(Buffer.concat(chunks).toString()));
      }
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-disposition', 'attachment; filename="wechat-export"');
      reply.header('x-content-type-options', 'nosniff');
      const size = response.headers['content-length'];
      if (size && /^\d+$/.test(size)) reply.header('content-length', size);
      reply.raw.once('close', () => response.destroy());
      return reply.send(response);
    } catch {
      return reply.code(503).send({ code: 'WOC_READ_UNAVAILABLE', error: 'Download unavailable' });
    }
  });
}
