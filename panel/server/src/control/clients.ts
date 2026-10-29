import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Actor } from './leases.js';

export interface ManagedClient { id: string; label: string; tokenHash: string; machines: string[] }
export function authenticateClient(token: string, clients: ManagedClient[]): ManagedClient | undefined {
  if (token.length < 32) return;
  const hash = createHash('sha256').update(token).digest();
  return clients.find(c => /^[a-zA-Z0-9_-]{1,64}$/.test(c.id) && /^[a-f0-9]{64}$/.test(c.tokenHash)
    && Array.isArray(c.machines) && timingSafeEqual(hash, Buffer.from(c.tokenHash, 'hex')));
}
export function configuredClient(token: string): ManagedClient | undefined {
  const path = process.env.WOC_CLIENTS_FILE;
  if (!path) return;
  try { return authenticateClient(token, JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return; } // A missing/invalid identity file never grants access.
}
export const clientCanAccess = (client: ManagedClient, id: string) => client.machines.includes('*') || client.machines.includes(id);
export const clientActor = (client: ManagedClient): Actor => ({ kind: 'agent', id: `client:${client.id}`, label: client.label.slice(0, 64) });
