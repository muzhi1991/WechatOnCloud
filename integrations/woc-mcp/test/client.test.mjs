import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('real MCP SDK client: tools, resources, live update, unsubscribe, reconnect and ACL errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'woc-mcp-test-'));
  let revision = 'first', polls = 0, lockWrites = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) {};
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer ' + 'x'.repeat(48)) { res.writeHead(401); res.end('{}'); return; }
    if (req.url.includes('private')) { res.writeHead(404); res.end(JSON.stringify({ code: 'WOC_MACHINE_NOT_FOUND' })); return; }
    if (req.url.endsWith('/ui_search')) { res.writeHead(409); res.end(JSON.stringify({ ok: false, code: 'WOC_WRONG_PAGE', execution: 'not_started', precondition: { page: 'contacts' } })); return; }
    if (req.url.endsWith('/navigate') || req.url.endsWith('/browser_open_url') || req.url.endsWith('/browser_article_react')) { assert.equal(req.headers['x-woc-expected-epoch'], 'a'.repeat(36)); }
    let result = {};
    if (req.url.endsWith('/machines')) result = { machines: [{ id: 'test', name: 'Test' }] };
    if (req.url.endsWith('/revision')) { polls++; result = { revision }; }
    if (req.url.endsWith('/sessions')) result = { sessions: [{ username: 'example', unread: 2, has_unread: true }] };
    if (req.url.endsWith('/acquire') || req.url.endsWith('/release')) lockWrites++;
    res.end(JSON.stringify(result));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  await writeFile(join(dir, 'token'), 'x'.repeat(48), { mode: 0o600 });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ panelUrl: `http://127.0.0.1:${upstream.address().port}`, tokenFile: join(dir, 'token'), notificationIntervalMs: 1000 }));
  const connect = async () => {
    const client = new Client({ name: 'woc-acceptance-client', version: '1' });
    const updates = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, message => { updates.push(message.params.uri); });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../server.mjs', import.meta.url)), join(dir, 'config.json')], stderr: 'pipe' }));
    return { client, updates };
  };
  let first, second;
  try {
    first = await connect();
    assert.equal(first.client.getServerCapabilities().resources.subscribe, true);
    const tools = await first.client.listTools();
    for (const name of ['woc_wechat_browser_article_state','woc_wechat_browser_article_react']) assert.ok(tools.tools.some(x=>x.name===name));
    await first.client.callTool({name:'woc_wechat_browser_article_state',arguments:{machine_id:'test'}});
    await first.client.callTool({name:'woc_wechat_browser_article_react',arguments:{machine_id:'test',lock_id:'a'.repeat(36),article_ref:'b'.repeat(32),expected_url:'https://mp.weixin.qq.com/s/test',reaction:'wow',request_id:'article-mcp-test-01'}});
    for (const name of ['woc_lock_acquire', 'woc_wechat_groups', 'woc_wechat_history', 'woc_wechat_extract', 'woc_wechat_browser_state', 'woc_wechat_browser_open_url']) assert.ok(tools.tools.some(x => x.name === name));
    assert.equal((await first.client.listResources()).resources[0].uri, 'wechat://test/messages');
    const response = await first.client.callTool({ name: 'woc_wechat_sessions', arguments: { machine_id: 'test', limit: 5 } });
    assert.equal(JSON.parse(response.content[0].text).sessions[0].unread, 2);
    const denied = await first.client.callTool({ name: 'woc_wechat_sessions', arguments: { machine_id: 'private' } });
    assert.equal(denied.isError, true);
    const uiError = await first.client.callTool({ name: 'woc_wechat_ui_search', arguments: { machine_id: 'test', scope: 'contacts', query: 'Example' } });
    assert.equal(uiError.isError, true);
    assert.deepEqual(uiError.structuredContent.precondition, { page: 'contacts' });
    assert.equal(JSON.parse(uiError.content[0].text).execution, 'not_started');
    await first.client.callTool({ name: 'woc_wechat_navigate', arguments: { machine_id: 'test', page: 'contacts', lock_id: 'a'.repeat(36) } });
    await first.client.callTool({ name: 'woc_wechat_browser_state', arguments: { machine_id: 'test' } });
    await first.client.callTool({ name: 'woc_wechat_browser_open_url', arguments: { machine_id: 'test', window_ref: 'b'.repeat(32), url: 'https://linux.weixin.qq.com', lock_id: 'a'.repeat(36) } });
    await assert.rejects(first.client.subscribeResource({ uri: 'wechat://private/messages' }));
    assert.equal(polls, 0);
    await first.client.subscribeResource({ uri: 'wechat://test/messages' });
    assert.equal(first.updates.length, 0);
    revision = 'second';
    const deadline = Date.now() + 5000;
    while (!first.updates.length && Date.now() < deadline) await sleep(50);
    assert.deepEqual(first.updates, ['wechat://test/messages']);
    await first.client.readResource({ uri: 'wechat://test/messages' });
    await first.client.unsubscribeResource({ uri: 'wechat://test/messages' });
    const previous = polls;
    revision = 'third';
    await sleep(1250);
    assert.equal(polls, previous);
    assert.equal(first.updates.length, 1);
    await first.client.close(); first = undefined;
    second = await connect();
    await second.client.subscribeResource({ uri: 'wechat://test/messages' });
    await sleep(1250);
    assert.equal(second.updates.length, 0); // No offline replay; fresh baseline.
    assert.equal(lockWrites, 0);
  } finally {
    await first?.client.close(); await second?.client.close();
    upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
