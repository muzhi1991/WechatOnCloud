import { mkdirSync, existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export type RecordKind = 'task' | 'action' | 'maintenance' | 'backup';
export interface JournalRecord {
  id: string; instance: string; kind: RecordKind; name: string; state: 'running' | 'done' | 'interrupted' | 'uncertain';
  at: number; endedAt?: number; epoch?: string; parent?: string; reason?: string;
  details?: Record<string, string | number | boolean>;
}
// One panel process owns this file. Payloads, chat text and credentials never enter it.
export class ControlJournal {
  private rows: JournalRecord[];
  constructor(readonly file: string, private now = Date.now) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, records: [] };
    if (saved.version !== 1 || !Array.isArray(saved.records)) throw new Error('Invalid lifecycle journal; refusing to overwrite it');
    this.rows = saved.records;
    for (const row of this.rows) if (row.state === 'running') {
      row.state = row.kind === 'action' ? 'uncertain' : 'interrupted'; row.reason = 'controller-restarted'; row.endedAt = this.now();
    }
    this.persist();
  }
  private persist() {
    // Keep unfinished maintenance/backup manifests; bound completed task/action history.
    const recent = new Set(this.rows.filter(r => r.kind !== 'backup').slice(-2000).map(r => r.id));
    this.rows = this.rows.filter(r => r.state === 'running' || (r.kind === 'maintenance' && r.state !== 'done') || r.kind === 'backup' || recent.has(r.id));
    const tmp = this.file + '.tmp', fd = openSync(tmp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, records: this.rows })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    const directory = openSync(dirname(this.file), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  list(instance: string, limit = 100) { return this.rows.filter(r => r.instance === instance).slice(-limit).reverse().map(r => structuredClone(r)); }
  get(id: string) { const row = this.rows.find(r => r.id === id); return row && structuredClone(row); }
  start(instance: string, kind: RecordKind, name: string, extra: Partial<Pick<JournalRecord, 'epoch' | 'parent' | 'details'>> = {}) {
    const row: JournalRecord = { id: randomUUID(), instance, kind, name: name.slice(0, 100), state: 'running', at: this.now(), ...extra };
    this.rows.push(row); this.persist(); return row.id;
  }
  finish(id: string, state: JournalRecord['state'], reason?: string, details?: JournalRecord['details']) {
    const row = this.rows.find(r => r.id === id); if (!row) throw new Error('Journal record missing');
    Object.assign(row, { state, reason, endedAt: this.now(), details: { ...row.details, ...details } }); this.persist();
  }
  task(instance: string, epoch: string) { return this.rows.slice().reverse().find(r => r.instance === instance && r.kind === 'task' && r.epoch === epoch)?.id; }
  endTask(instance: string, epoch: string, reason: string) {
    const id = this.task(instance, epoch); if (id && this.get(id)?.state === 'running') this.finish(id, reason === 'released' ? 'done' : 'interrupted', reason);
  }
  unresolved(instance: string) { return this.rows.slice().reverse().find(r => r.instance === instance && r.kind === 'maintenance' && r.state !== 'done'); }
  resolve(instance: string) {
    for (const row of this.rows) if (row.instance === instance && row.kind === 'maintenance' && row.state !== 'done') {
      row.state = 'done'; row.reason = 'administrator-reviewed'; row.endedAt = this.now();
    }
    this.persist();
  }
}
