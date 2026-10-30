// Application-specific operations; no arbitrary coordinate/key/script interface.
const text = { type: 'string', minLength: 1, maxLength: 2000 };
const name = { type: 'string', minLength: 1, maxLength: 256 };
const requestId = { type: 'string', pattern: '^[a-zA-Z0-9_-]{16,128}$' };
export const uiOperations = {
  browser_profile_state: { read: true, description: 'Read the currently open followed public-account profile, visible article titles and viewport. No searching or scrolling. Unfollowed accounts are rejected.', properties: {} },
  browser_profile_open: { description: 'Open one freshly observed article or the Articles tab on a followed account profile. Requires GUI lock and caller-bound target_ref; no search or scrolling.', properties: { target_ref: { type: 'string', pattern: '^[a-f0-9]{32}$' } } },
  browser_article_state: { read: true, description: 'Observe the loaded WeChat public-account article and its toolbar like/heart (在看) states. No lock, navigation or scrolling. Returns a caller-bound article_ref; unsupported layouts fail explicitly.', properties: {} },
  browser_article_react: { description: 'Ensure one article toolbar reaction is active: like=赞, wow=heart/在看 (may be visible to friends). Requires GUI lock, fresh article_ref, expected_url and unique request_id. Never cancels an active reaction. Does not open/navigate/scroll; inspect state after input and never blindly replay uncertain results.', properties: { article_ref: { type: 'string', pattern: '^[a-f0-9]{32}$' }, expected_url: { type: 'string', minLength: 1, maxLength: 8192 }, reaction: { enum: ['like', 'wow'] }, request_id: requestId } },
  browser_state: { read: true, description: 'Observe WeChat embedded browser window and document URL/title. No write lock; returns a caller-bound window reference. Page content is not interpreted.', properties: {} },
  browser_open_url: { description: 'Submit an HTTP(S) URL in an already open WeChat embedded browser. Requires GUI lock and fresh window_ref; does not launch the browser or wait for page load.', properties: { window_ref: { type: 'string', pattern: '^[a-f0-9]{32}$' }, url: { type: 'string', minLength: 1, maxLength: 8192 } } },
  ui_state: { read: true, description: 'Observe the current WeChat page, dialog, visible local items and draft. No GUI write lock needed.', properties: {} },
  navigate: { description: 'Enter a supported WeChat page. Requires your GUI lock. Does not acquire it.', properties: { page: { enum: ['conversations', 'contacts', 'favorites', 'web_search'] } } },
  ui_search: { description: 'Search from the current WeChat conversations or contacts page. Requires your GUI lock; no scrolling or automatic navigation.', properties: { scope: { enum: ['conversations', 'contacts'] }, query: name } },
  open_item: { description: 'Open a current, caller-bound WeChat item reference. Rejects stale references. Requires your GUI lock.', properties: { target_ref: { type: 'string', pattern: '^[a-f0-9]{32}$' } } },
  fill_text: { description: 'Paste text into the verified current WeChat chat. Default requires an empty draft. Does not send. Requires your GUI lock.', properties: { expected_chat: name, text, expected_draft: { type: 'string', maxLength: 2000 } }, optional: ['expected_draft'] },
  send_draft: { description: 'Click Send only if current WeChat chat and draft match. Requires your GUI lock. Reuse request_id for the same send; unknown results must not be replayed.', properties: { expected_chat: name, expected_text: text, request_id: requestId } },
  ui_request_status: { read: true, description: 'Read this caller’s stored send or article-reaction execution receipt. No write lock. Receipts retained for seven days; not a delivery or server-persistence receipt.', properties: { request_id: requestId } },
};
export function uiSchema(op, mcp = false) {
  const spec = uiOperations[op];
  return { type: 'object', additionalProperties: false,
    properties: { ...(mcp ? { machine_id: name, ...(!spec.read ? { lock_id: { type: 'string', pattern: '^[a-f0-9-]{36}$' } } : {}) } : {}), ...spec.properties },
    required: [...(mcp ? ['machine_id'] : []), ...Object.keys(spec.properties).filter(k => !(spec.optional || []).includes(k))] };
}
