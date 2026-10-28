import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const digest = token => createHash('sha256').update(token).digest('hex');

// macOS launchd may restrict Node's LAN access while the system HTTP client is
// permitted. Keep this explicit and pass credentials through stdin, never argv.
export async function curlRequest(url, token, body, binary) {
  if (/[\r\n]/.test(token)) throw new Error('Invalid service credential');
  const config = `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}\n` +
    (body ? `header = "Content-Type: application/json"\ndata = ${JSON.stringify(JSON.stringify(body))}\n` : '');
  const output = await new Promise((resolve, reject) => {
    const child = execFile(binary, ['--silent', '--show-error', '--max-time', '10', '--proto', '=http,https',
      '--config', '-', '--write-out', '\n%{http_code}', url], { timeout: 12_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => error ? reject(new Error('System HTTP client failed')) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(config);
  });
  const split = output.lastIndexOf('\n');
  const status = Number(output.slice(split + 1));
  if (status < 200 || status >= 300) throw new Error(`Panel sync HTTP ${status}`);
  try { return JSON.parse(output.slice(0, split)); }
  catch { throw new Error('Invalid panel JSON response'); }
}

export function validateSnapshot(snapshot, config) {
  if (snapshot?.version !== 1 || snapshot.deploymentId !== config.deploymentId ||
      snapshot.namespace !== config.namespace || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.records)) {
    throw new Error('Invalid snapshot identity/version');
  }
  const ids = new Set(), endpoints = new Set();
  for (const row of snapshot.records) {
    if (!/^[a-f0-9]{10}$/.test(row.id) || row.name !== `${config.namespace}-${row.id}` || ids.has(row.id) ||
        !Number.isSafeInteger(row.generation) || row.generation < 1 ||
        !['ready', 'starting', 'offline', 'error', 'deleted', 'orphaned'].includes(row.state)) throw new Error('Invalid snapshot record');
    const url = new URL(row.endpoint);
    if (url.protocol !== 'http:' || url.hostname !== config.allowedHost || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || Number(url.port) < config.firstPort || Number(url.port) > config.lastPort || endpoints.has(row.endpoint)) {
      throw new Error('Endpoint outside the configured Cua scope');
    }
    if (row.state === 'ready' && !/^[a-f0-9]{64}$/.test(row.token || '')) throw new Error('Missing ready credential');
    ids.add(row.id); endpoints.add(row.endpoint);
  }
}

// Adapter seam used by both the daemon and failure/restart tests. It never creates/deletes Docker containers.
export async function reconcile(snapshot, state, adapter, config) {
  validateSnapshot(snapshot, config);
  if (state.deploymentId !== snapshot.deploymentId) throw new Error('State belongs to another deployment');
  if (snapshot.revision < state.revision) return; // Reject delayed snapshots after a newer generation.
  state.revision = snapshot.revision;
  await adapter.save(state);
  const existing = await adapter.list();
  const failures = [];
  for (const row of snapshot.records) {
    const owned = state.records[row.id];
    if (owned && row.generation < owned.generation) continue;
    const ref = `direct:${new URL(row.endpoint).host}`;
    if (row.state === 'deleted') {
      if (!owned) continue;
      const current = existing.find(x => x.id === owned.ref);
      if (current && current.name !== owned.name && current.display_name !== owned.name) {
        throw new Error(`Refusing to forget a renamed/unowned registration: ${row.id}`);
      }
      if (current) await adapter.remove(owned.ref);
      delete state.records[row.id];
      await adapter.save(state);
      continue;
    }
    if (row.state !== 'ready') continue; // Offline/pending/orphaned is not deletion.
    const current = existing.find(x => x.id === ref);
    if (current && (!owned || owned.ref !== ref || (current.name !== row.name && current.display_name !== row.name))) {
      throw new Error(`Registration collision outside this coordinator's ownership: ${row.id}`);
    }
    if (owned && owned.ref !== ref) {
      const old = existing.find(x => x.id === owned.ref);
      if (old && old.name !== owned.name && old.display_name !== owned.name) throw new Error('Previous endpoint ownership changed');
      if (old) await adapter.remove(owned.ref);
    }
    const tokenDigest = digest(row.token);
    const changed = !current || !owned || owned.pending || owned.generation !== row.generation || owned.tokenDigest !== tokenDigest;
    if (changed) {
      // Claim durably before CLI side effects; a crash between add and save is recoverable.
      state.records[row.id] = { ref, name: row.name, generation: row.generation, tokenDigest, pending: true };
      await adapter.save(state);
      try {
        await adapter.add(row.endpoint, row.name, row.token);
        state.records[row.id].pending = false;
        await adapter.save(state);
      } catch {
        await adapter.ack(row.id, row.generation, 'error').catch(() => {});
        failures.push(row.id); // Other ready instances must still converge.
        continue;
      }
    }
    try { await adapter.ack(row.id, row.generation, 'registered'); }
    catch { failures.push(row.id); }
  }
  if (failures.length) throw new Error(`Cua sync incomplete for ${failures.join(', ')}`);
}

function atomicJson(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path); chmodSync(path, 0o600);
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Usage: node sync.mjs CONFIG.json [--once]');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const stateFile = config.stateFile;
  if (!stateFile || !config.serviceTokenFile || !config.panelUrl || !config.cuaBinary) throw new Error('Incomplete config');
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const lock = `${stateFile}.lock`;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lock; inspect it manually');
    try { process.kill(pid, 0); throw new Error('Coordinator is already running'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    unlinkSync(lock);
  }
  const fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
  let stopped = false;
  const cleanup = () => { try { unlinkSync(lock); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { stopped = true; });
  process.on('SIGINT', () => { stopped = true; });
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8'))
    : { deploymentId: config.deploymentId, revision: -1, records: {} };
  const request = async (path, body) => {
    const token = readFileSync(config.serviceTokenFile, 'utf8').trim();
    const url = `${config.panelUrl.replace(/\/$/, '')}${path}`;
    if (config.curlBinary) return curlRequest(url, token, body, config.curlBinary);
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Panel sync HTTP ${response.status}`);
    try { return await response.json(); }
    catch { throw new Error('Invalid panel JSON response'); }
  };
  const cli = async (args, token) => execute(config.cuaBinary, args, {
    env: { ...process.env, ...(token ? { CUA_ENV_TOKEN: token } : {}) }, timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
  });
  const adapter = {
    list: async () => JSON.parse((await cli(['spaces', 'ls', '--json'])).stdout).spaces,
    add: async (endpoint, name, token) => { await cli(['spaces', 'add', endpoint, '--name', name], token); },
    remove: async ref => { await cli(['spaces', 'rm', ref]); },
    save: async value => atomicJson(stateFile, value),
    ack: async (id, generation, status) => request('/api/integrations/cua/ack', { deploymentId: config.deploymentId, id, generation, status }),
  };
  const once = process.argv.includes('--once');
  do {
    try {
      const snapshot = await request('/api/integrations/cua/snapshot');
      await reconcile(snapshot, state, adapter, config);
      atomicJson(`${stateFile}.status`, { at: new Date().toISOString(), healthy: true, revision: state.revision, registered: Object.keys(state.records).length });
    } catch (e) {
      const error = e.cause?.code ? `${e.message} (${e.cause.code})` : e.message;
      console.error(`[woc-cua-sync] ${error}`);
      atomicJson(`${stateFile}.status`, { at: new Date().toISOString(), healthy: false, error });
      if (once) { process.exitCode = 1; break; }
    }
    if (once || stopped) break;
    await new Promise(r => setTimeout(r, Math.max(2, config.intervalSec || 10) * 1000));
  } while (!stopped);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => {
  console.error(`[woc-cua-sync] ${e.message}`); process.exitCode = 1;
});
