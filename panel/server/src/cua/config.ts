import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';

export interface CuaConfig {
  image: string;
  bindIp: string;
  publicHost: string;
  firstPort: number;
  lastPort: number;
  namespace: string;
  stateFile: string;
  secretsDir: string;
  hostSecretsDir: string;
  serviceTokenFile: string;
  cpus: number;
}

export function readCuaConfig(env: NodeJS.ProcessEnv = process.env): CuaConfig | null {
  if (env.WOC_CUA_ENABLED !== '1') return null;
  const required = (key: string) => {
    const v = (env[key] || '').trim();
    if (!v) throw new Error(`${key} is required when Cua is enabled`);
    return v;
  };
  const image = required('WOC_CUA_IMAGE');
  if (!/^sha256:[a-f0-9]{64}$/.test(image) && !/@sha256:[a-f0-9]{64}$/.test(image) &&
      !/:[^/:@]+$/.test(image)) throw new Error('WOC_CUA_IMAGE must have a fixed tag or digest');
  if (/:latest$/.test(image)) throw new Error('WOC_CUA_IMAGE cannot use latest');
  const bindIp = required('WOC_CUA_BIND_IP');
  if (isIP(bindIp) !== 4 || bindIp === '0.0.0.0') throw new Error('WOC_CUA_BIND_IP must be a specific IPv4 address');
  const publicHost = required('WOC_CUA_PUBLIC_HOST');
  if (!/^[a-zA-Z0-9.-]+$/.test(publicHost)) throw new Error('Invalid WOC_CUA_PUBLIC_HOST');
  const firstPort = Number(env.WOC_CUA_PORT_FIRST ?? 13320);
  const lastPort = Number(env.WOC_CUA_PORT_LAST ?? 13339);
  if (![firstPort, lastPort].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535) || lastPort < firstPort) {
    throw new Error('Invalid Cua port range');
  }
  const namespace = env.WOC_CUA_NAMESPACE || 'woc-cua';
  if (!/^[a-z][a-z0-9-]{2,30}$/.test(namespace)) throw new Error('Invalid Cua namespace');
  const path = (key: string, fallback?: string) => {
    const value = env[key] || fallback || required(key);
    if (!isAbsolute(value) || /[:\n\r]/.test(value)) throw new Error(`Invalid ${key}`);
    return value;
  };
  const cpus = Number(env.WOC_CUA_CPUS ?? 2);
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 16) throw new Error('Invalid WOC_CUA_CPUS');
  return { image, bindIp, publicHost, firstPort, lastPort, namespace, cpus,
    stateFile: path('WOC_CUA_STATE_FILE', '/data/panel/cua/instances.json'),
    secretsDir: path('WOC_CUA_SECRETS_DIR', '/data/cua-secrets'),
    hostSecretsDir: path('WOC_CUA_HOST_SECRETS_DIR'),
    serviceTokenFile: path('WOC_CUA_SYNC_TOKEN_FILE', '/run/secrets/cua-sync-token') };
}

export function watchdogInterval(raw: string | undefined): number {
  const value = Number(raw ?? 300);
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid WOC_WATCHDOG_INTERVAL_SEC');
  return value === 0 ? 0 : Math.max(60, value);
}

export const cuaConfig = readCuaConfig();
