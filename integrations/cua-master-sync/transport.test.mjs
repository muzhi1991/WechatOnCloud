import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { curlRequest } from './sync.mjs';

test('system HTTP transport authenticates POSTs, refuses redirects and redacts invalid JSON', async t => {
  const token = 'a'.repeat(64);
  let redirected = false;
  const server = createServer(async (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/destination' }); res.end(); return; }
    if (req.url === '/destination') { redirected = true; res.end('{}'); return; }
    if (req.url === '/invalid') { res.end(`broken JSON ${token}`); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ authenticated: req.headers.authorization === `Bearer ${token}`,
      method: req.method, body: JSON.parse(Buffer.concat(chunks).toString()) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { id: '0123456789', generation: 2, status: 'registered' };
  assert.deepEqual(await curlRequest(base + '/ack', token, body, 'curl'), { authenticated: true, method: 'POST', body });
  await assert.rejects(curlRequest(base + '/redirect', token, undefined, 'curl'), /HTTP 302/);
  assert.equal(redirected, false);
  await assert.rejects(curlRequest(base + '/invalid', token, undefined, 'curl'), { message: 'Invalid panel JSON response' });
});
