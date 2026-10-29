// Real account acceptance. Prints counts/types only, never conversations or credentials.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const [configFile, machine_id, reportFile] = process.argv.slice(2);
assert.ok(configFile && machine_id && reportFile, 'config, machine ID and private report path are required');
const config = JSON.parse(await readFile(configFile, 'utf8'));
const client = new Client({ name: 'woc-real-acceptance', version: '1' });
const reports = [];
const record = value => { reports.push(value); console.log(JSON.stringify(value)); };
const notifications = [];
client.setNotificationHandler(ResourceUpdatedNotificationSchema, value => { notifications.push(value.params.uri); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await client.connect(new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('./server.mjs', import.meta.url)), configFile], stderr: 'pipe' }));
async function query(op, args = {}) {
  const response = await client.callTool({ name: `woc_wechat_${op}`, arguments: { machine_id, ...args } }, undefined, { timeout: 120000 });
  assert.notEqual(response.isError, true, `${op} failed`);
  return JSON.parse(response.content[0].text);
}
try {
  assert.equal((await query('health')).ready, true);
  const sessions = await query('sessions', { limit: 50 });
  assert.ok(sessions.sessions.length > 0);
  for (const row of sessions.sessions) assert.equal(row.has_unread, row.unread > 0);
  record({ check: 'sessions_and_unread_flags', count: sessions.sessions.length });
  const unread = await query('unread', { limit: 50 });
  assert.ok(unread.sessions.every(x => x.unread > 0)); record({ check: 'unread', count: unread.sessions.length });
  const contacts = await query('contacts', { limit: 50 });
  assert.ok(contacts.length > 0); record({ check: 'contacts', count: contacts.length });
  const groups = await query('groups', { limit: 50 });
  assert.ok(groups.groups.length > 0); record({ check: 'groups', count: groups.groups.length });
  for (const group of groups.groups.slice(0, 2)) {
    const members = await query('members', { chat: group.username });
    assert.ok(members.length > 0); record({ check: 'group_members', count: members.length });
  }
  let selected;
  for (const session of sessions.sessions.filter(x => x.chat_type === 'private').slice(0, 10)) {
    const attachments = await query('attachments', { chat: session.username, limit: 100, kinds: ['image', 'voice', 'video', 'file', 'sticker'] });
    if (!selected || attachments.attachments.length > selected.attachments.length) selected = { chat: session.username, attachments: attachments.attachments };
  }
  assert.ok(selected?.attachments.length);
  const history = await query('history', { chat: selected.chat, limit: 50 });
  assert.ok(history.messages.length > 0);
  record({ check: 'history', count: history.messages.length, types: [...new Set(history.messages.map(x => x.type))].sort() });
  const page = await query('history', { chat: selected.chat, limit: 2, offset: 1 });
  assert.ok(page.messages.length <= 2);
  const keyword = history.messages.find(x => x.type === '文本' && x.content?.length >= 2)?.content.slice(0, 2);
  assert.ok(keyword);
  const search = await query('search', { keyword, chats: [selected.chat], limit: 20 });
  assert.ok(search.results.length > 0); record({ check: 'search', count: search.results.length });
  for (const attachment of selected.attachments) {
    const result = await query('extract', { attachment_id: attachment.attachment_id });
    if (!result.exported) { record({ check: 'local_media_unavailable', kind: attachment.kind, status: result.local_status }); continue; }
    const url = new URL(result.download_url);
    assert.equal(url.origin, new URL(config.panelUrl).origin);
    const denied = await fetch(url); assert.equal(denied.status, 401); await denied.arrayBuffer();
    const token = (await readFile(config.tokenFile, 'utf8')).trim();
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, result.output_size);
    record({ check: 'local_media_download', kind: attachment.kind, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const uri = `wechat://${machine_id}/messages`;
  await client.subscribeResource({ uri });
  // Only a disposable snapshot may be touched. Never point this at the original account.
  const testFile = process.env.WOC_TEST_SNAPSHOT_DB;
  if (testFile) {
    assert.ok(testFile.includes('/woc-read-private/account/'), 'Only the disposable test snapshot may be touched');
    const original = await stat(testFile);
    await utimes(testFile, original.atime, new Date());
    const deadline = Date.now() + 15000;
    while (!notifications.length && Date.now() < deadline) await sleep(100);
    assert.ok(notifications.includes(uri));
    await client.readResource({ uri });
    record({ check: 'real_sdk_notification_and_reread', trigger: 'disposable_snapshot_metadata_change', received: true });
  } else record({ check: 'resource_subscription', accepted: true, live_change_triggered: false });
  await client.unsubscribeResource({ uri });
  await writeFile(reportFile, reports.map(x => JSON.stringify(x)).join('\n') + '\n', { mode: 0o600 });
} finally {
  await client.close();
}
