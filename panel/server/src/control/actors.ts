import type { Actor } from './leases.js';

// The authenticated user owns control, not a browser tab or connection.
export function humanActor(user: { id: string; username: string }, _connection?: unknown): Actor {
  return { kind: 'human', id: `user:${user.id}`, label: `${user.username}（人工）` };
}
