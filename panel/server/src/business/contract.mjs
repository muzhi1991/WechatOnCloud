// Public data contract shared with the stdio MCP adapter. No control-lock methods.
const str = { type: 'string', minLength: 1, maxLength: 256 };
const limit = { type: 'integer', minimum: 1, maximum: 500 };
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const range = { since: date, until: date };
const type = { type: 'string', enum: ['text', 'image', 'voice', 'video', 'sticker', 'location', 'link', 'file', 'call', 'system'] };
const page = { limit, offset: { type: 'integer', minimum: 0, maximum: 100000 } };
const array = items => ({ type: 'array', maxItems: 20, items });
export const operations = {
  health: { description: 'Check local WeChat read service readiness.', properties: {} },
  sessions: { description: 'Recent conversations, including WeChat conversation-level unread counts. Does not mark read.', properties: { limit } },
  unread: { description: 'Conversations with unread messages in the local WeChat snapshot, not agent processing state.', properties: { limit, filter: array({ type: 'string', enum: ['all', 'private', 'group', 'official', 'folded'] }) } },
  contacts: { description: 'Find personal contacts by name or ID.', properties: { query: str, limit } },
  groups: { description: 'Find groups in the local contact inventory, including groups outside recent conversations.', properties: { query: str, limit } },
  members: { description: 'Read members of a group. Prefer its exact username from groups.', properties: { chat: str }, required: ['chat'] },
  history: { description: 'Read the latest N messages of a person or group; optional offset/date/type filters. Prefer exact chat username.', properties: { chat: str, ...page, ...range, type }, required: ['chat'] },
  search: { description: 'Search local messages; optionally limit to chats, dates and message type.', properties: { keyword: str, chats: array(str), limit, ...range, type }, required: ['keyword'] },
  attachments: { description: 'List local attachment handles and availability. Never triggers downloads or GUI input.', properties: { chat: str, kinds: array({ type: 'string', enum: ['image', 'img', 'video', 'file', 'sticker', 'voice'] }), ...page, ...range }, required: ['chat'] },
  extract: { description: 'Export an already-local attachment to temporary private storage. Returns an authenticated download URL or exported=false. No network download or GUI input.', properties: { attachment_id: { type: 'string', minLength: 1, maxLength: 8192 } }, required: ['attachment_id'] },
  revision: { description: 'Internal change hint, not a message sequence or consumer cursor.', properties: {} },
};
export function schema(operation, machine = false) {
  const spec = operations[operation];
  return { type: 'object', properties: { ...(machine ? { machine_id: str } : {}), ...spec.properties },
    required: [...(machine ? ['machine_id'] : []), ...(spec.required || [])], additionalProperties: false };
}
