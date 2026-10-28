import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Instance } from '../store.js';
import { cuaConfig, type CuaConfig } from './config.js';

export interface CuaRecord {
  id: string;
  incarnation: string;
  name: string;
  hostPort: number;
  endpoint: string;
  secretRef: string;
  generation: number;
  desired: 'running' | 'stopped' | 'deleted';
}
interface State { deploymentId: string; revision: number; reservedPorts: number[]; records: CuaRecord[] }
export interface CuaAck { generation: number; status: 'registered' | 'error'; at: string }

// Atomic, synchronous reservations serialize concurrent instance creation in this panel process.
// One panel writer per data directory. Tombstones and reserved ports survive restarts.
export class CuaRegistry {
  private state: State;
  private acks = new Map<string, CuaAck>();
  constructor(readonly config: CuaConfig) {
    mkdirSync(config.secretsDir, { recursive: true, mode: 0o700 });
    chmodSync(config.secretsDir, 0o700);
    this.state = existsSync(config.stateFile)
      ? JSON.parse(readFileSync(config.stateFile, 'utf8'))
      : { deploymentId: randomUUID(), revision: 0, reservedPorts: [], records: [] };
    if (!this.state.deploymentId || !Array.isArray(this.state.records) || !Array.isArray(this.state.reservedPorts)) {
      throw new Error('Invalid Cua registry; refusing to replace existing state');
    }
    this.persist();
  }
  private persist() {
    mkdirSync(dirname(this.config.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.config.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.config.stateFile);
    chmodSync(this.config.stateFile, 0o600);
  }
  private changed() { this.state.revision++; this.persist(); }
  get deploymentId() { return this.state.deploymentId; }
  get revision() { return this.state.revision; }
  records() { return this.state.records.map(r => ({ ...r })); }
  get(id: string) { const r = this.state.records.find(r => r.id === id); return r ? { ...r } : undefined; }
  prepare(inst: Pick<Instance, 'id' | 'createdAt'>, occupied: Set<number>): CuaRecord {
    let record = this.state.records.find(r => r.id === inst.id);
    if (record?.desired === 'deleted' && record.incarnation === inst.createdAt) throw new Error('Instance was deleted');
    if (!record || record.incarnation !== inst.createdAt) {
      const reserved = new Set([...this.state.reservedPorts, ...occupied]);
      let port = this.config.firstPort;
      while (port <= this.config.lastPort && reserved.has(port)) port++;
      if (port > this.config.lastPort) throw new Error('Cua port range exhausted (retired ports remain reserved)');
      const secretRef = `${randomUUID()}.token`;
      writeFileSync(join(this.config.secretsDir, secretRef), randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
      const next: CuaRecord = { id: inst.id, incarnation: inst.createdAt, name: `${this.config.namespace}-${inst.id}`,
        hostPort: port, endpoint: `http://${this.config.publicHost}:${port}`, secretRef,
        generation: (record?.generation || 0), desired: 'running' };
      this.state.reservedPorts.push(port);
      this.state.records = this.state.records.filter(r => r.id !== inst.id);
      this.state.records.push(next);
      record = next;
    }
    // Never silently replace a lost token; that would strand the existing Master identity.
    this.token(record.id);
    record.generation++;
    record.desired = 'running';
    this.acks.delete(record.id);
    this.changed();
    return { ...record };
  }
  token(id: string): string {
    const record = this.get(id);
    if (!record || record.desired === 'deleted') throw new Error('Cua credential unavailable');
    const token = readFileSync(join(this.config.secretsDir, record.secretRef), 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid Cua credential');
    return token;
  }
  stopped(id: string, stopped: boolean) {
    const record = this.state.records.find(r => r.id === id);
    if (!record || record.desired === 'deleted') return;
    record.desired = stopped ? 'stopped' : 'running';
    this.changed();
  }
  retire(id: string) {
    const record = this.state.records.find(r => r.id === id);
    if (!record || record.desired === 'deleted') return;
    record.desired = 'deleted'; record.generation++;
    this.acks.delete(id);
    this.changed(); // Persist revocation before deleting its credential.
    try { unlinkSync(join(this.config.secretsDir, record.secretRef)); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
  ack(id: string, generation: number, status: CuaAck['status']): boolean {
    const r = this.get(id);
    if (!r || r.generation !== generation || r.desired === 'deleted') return false;
    this.acks.set(id, { generation, status, at: new Date().toISOString() });
    return true;
  }
  ackFor(id: string) { return this.acks.get(id); }
  containerOptions(record: CuaRecord) {
    return {
      env: ['WOC_CUA_ENABLED=1', 'WOC_RESTORE_MINIMIZED=0'],
      bind: `${join(this.config.hostSecretsDir, record.secretRef)}:/run/secrets/cua-token:ro`,
      ports: { '3211/tcp': [{ HostIp: this.config.bindIp, HostPort: String(record.hostPort) }] },
      labels: { 'io.woc.cua.deployment': this.deploymentId, 'io.woc.cua.instance': record.id,
        'io.woc.cua.generation': String(record.generation) },
    };
  }
}

export const cuaRegistry = cuaConfig ? new CuaRegistry(cuaConfig) : null;
