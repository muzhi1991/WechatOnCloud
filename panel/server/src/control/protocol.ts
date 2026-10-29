import { nativeMethods } from './native-methods.js';
export type OperationKind = 'read' | 'write' | 'bypass' | 'deny';
const readMethods = new Set([
  'SystemService/GetCapabilities', 'SystemService/Health', 'SystemService/Metrics',
  'ComputerService/Screenshot', 'ComputerService/GetClipboard', 'ComputerService/GetCursorPosition', 'ComputerService/ListDisplays',
  'WindowsService/WatchWindows', 'WindowsService/ListWindows', 'WindowsService/GetWindow', 'AccessibilityService/GetTree', 'AccessibilityService/Find',
  'DriverService/ListTools', 'StreamService/ListTargets',
]);
const writeMethods = new Set([
  'ComputerService/Pointer', 'ComputerService/Keyboard', 'ComputerService/SetClipboard', 'AccessibilityService/Act',
  'WindowsService/ActivateWindow', 'WindowsService/SetWindowBounds', 'WindowsService/MinimizeWindow',
  'WindowsService/MaximizeWindow', 'WindowsService/RestoreWindow', 'WindowsService/CloseWindow', 'WindowsService/LaunchApp', 'WindowsService/Open',
]);
const readTools = new Set(['list_apps', 'list_windows', 'get_window_state', 'verify_state', 'clipboard_read',
  'get_screen_size', 'get_desktop_state', 'get_cursor_position', 'get_agent_cursor_state', 'get_accessibility_tree',
  'check_permissions', 'health_report', 'get_browser_state', 'get_recording_state', 'get_config', 'get_session', 'list_sessions', 'get_session_state', 'get_guide', 'zoom']);
const writeTools = new Set(['run_script', 'replay_trajectory', 'browser_prepare', 'browser_navigate', 'browser_click', 'browser_type', 'browser_select', 'browser_dialog', 'browser_set_input_files', 'browser_download', 'browser_pointer', 'set_agent_cursor_enabled', 'set_agent_cursor_motion', 'set_agent_cursor_theme', 'set_config', 'launch_app', 'kill_app', 'bring_to_front', 'set_window_frame', 'invoke_menu',
  'click', 'double_click', 'right_click', 'drag', 'mouse_button_down', 'mouse_drag', 'mouse_button_up',
  'parallel_mouse_drag', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll', 'clipboard_write', 'move_cursor']);

const bypassTools = new Set(['start_session', 'escalate_session', 'end_session', 'start_recording', 'stop_recording', 'install_ffmpeg']);

// Decode only protobuf string field 1 (CallTool.name). Reject malformed,
// compressed, multi-message, or duplicate-name requests before dispatch.
function toolCall(frame: Buffer): { name: string; args: any } {
  if (frame.length < 5 || frame[0] !== 0 || frame.readUInt32BE(1) !== frame.length - 5) throw new Error('Invalid unary frame');
  let i = 5; let name: string | undefined, args: string | undefined;
  const varint = () => { let n = 0, shift = 0; while (i < frame.length && shift < 49) { const b = frame[i++]; n += (b & 127) * 2 ** shift; if (!(b & 128)) return n; shift += 7; } throw new Error('Invalid protobuf'); };
  while (i < frame.length) {
    const tag = varint(), field = Math.floor(tag / 8), wire = tag & 7;
    if (!field) throw new Error('Invalid protobuf field');
    if (wire === 2) {
      const len = varint(); if (i + len > frame.length) throw new Error('Truncated protobuf');
      if (field === 1) { if (name !== undefined) throw new Error('Duplicate tool name'); name = frame.subarray(i, i + len).toString('utf8'); }
      if (field === 2) { if (args !== undefined) throw new Error('Duplicate tool arguments'); args = frame.subarray(i, i + len).toString('utf8'); }
      i += len;
    } else if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error('Unsupported protobuf field');
    if (i > frame.length) throw new Error('Truncated protobuf');
  }
  return { name: name || '', args: args ? JSON.parse(args) : {} };
}
export function classifyTool(name: string, args: any = {}, depth = 0): OperationKind {
  if (depth > 8) return 'deny';
  if (name === 'page') return ['get_text', 'query_dom'].includes(args?.action) ? 'read'
    : ['execute_javascript', 'click_element', 'insert_text', 'type_keystrokes', 'enable_javascript_apple_events'].includes(args?.action) ? 'write' : 'deny';
  if (name === 'run_steps') {
    if (!Array.isArray(args?.steps)) return 'deny';
    const kinds = args.steps.map((step: any) => {
      if (!step || typeof step !== 'object') return 'deny';
      const tool = step.tool || Object.keys(step).find(k => !['args', 'wait_for', 'expect', 'timeout_ms'].includes(k));
      return tool ? classifyTool(tool, step.args || step[tool] || {}, depth + 1) : 'read';
    });
    if (kinds.includes('deny')) return 'deny';
    return kinds.includes('write') ? 'write' : kinds.includes('bypass') ? 'bypass' : 'read';
  }
  return readTools.has(name) ? 'read' : writeTools.has(name) ? 'write' : bypassTools.has(name) ? 'bypass' : 'deny';
}
export function classifyRpc(path: string, frame: Buffer): OperationKind {
  const method = /^\/cua\.env\.v1\.([^?]+)$/.exec(path)?.[1];
  if (!method) return 'deny';
  if (method === 'DriverService/CallTool') {
    const { name, args } = toolCall(frame);
    return classifyTool(name, args);
  }
  return readMethods.has(method) ? 'read' : writeMethods.has(method) ? 'write' : nativeMethods.has(method) ? 'bypass' : 'deny';
}
export function grpcWebSucceeded(body: Buffer): boolean {
  let i = 0; let ok = false;
  while (i + 5 <= body.length) {
    const flag = body[i], length = body.readUInt32BE(i + 1); i += 5;
    if (i + length > body.length) return false;
    if (flag === 128) ok = /(?:^|\r?\n)grpc-status:\s*0(?:\r?\n|$)/.test(body.subarray(i, i + length).toString());
    i += length;
  }
  return i === body.length && ok;
}
