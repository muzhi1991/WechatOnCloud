const readMethods = new Set([
  'SystemService/GetCapabilities', 'SystemService/Health', 'SystemService/Metrics',
  'ComputerService/Screenshot', 'ComputerService/GetClipboard', 'ComputerService/GetCursorPosition', 'ComputerService/ListDisplays',
  'WindowsService/ListWindows', 'WindowsService/GetWindow', 'AccessibilityService/GetTree', 'AccessibilityService/Find',
  'DriverService/ListTools', 'StreamService/ListTargets',
]);
const writeMethods = new Set([
  'ComputerService/Pointer', 'ComputerService/Keyboard', 'ComputerService/SetClipboard', 'AccessibilityService/Act',
  'WindowsService/ActivateWindow', 'WindowsService/SetWindowBounds', 'WindowsService/MinimizeWindow',
  'WindowsService/MaximizeWindow', 'WindowsService/RestoreWindow', 'WindowsService/CloseWindow', 'WindowsService/LaunchApp', 'WindowsService/Open',
]);
const readTools = new Set(['list_apps', 'list_windows', 'get_window_state', 'verify_state', 'clipboard_read',
  'get_screen_size', 'get_desktop_state', 'get_cursor_position', 'get_agent_cursor_state', 'get_accessibility_tree',
  'get_config', 'get_session', 'list_sessions', 'get_session_state', 'get_guide', 'zoom']);
const writeTools = new Set(['launch_app', 'kill_app', 'bring_to_front', 'set_window_frame', 'invoke_menu',
  'click', 'double_click', 'right_click', 'drag', 'mouse_button_down', 'mouse_drag', 'mouse_button_up',
  'parallel_mouse_drag', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll', 'clipboard_write', 'move_cursor']);

// Decode only protobuf string field 1 (CallTool.name). Reject malformed,
// compressed, multi-message, or duplicate-name requests before dispatch.
function toolName(frame: Buffer): string {
  if (frame.length < 5 || frame[0] !== 0 || frame.readUInt32BE(1) !== frame.length - 5) throw new Error('Invalid unary frame');
  let i = 5; let name: string | undefined;
  const varint = () => { let n = 0, shift = 0; while (i < frame.length && shift < 49) { const b = frame[i++]; n += (b & 127) * 2 ** shift; if (!(b & 128)) return n; shift += 7; } throw new Error('Invalid protobuf'); };
  while (i < frame.length) {
    const tag = varint(), field = Math.floor(tag / 8), wire = tag & 7;
    if (!field) throw new Error('Invalid protobuf field');
    if (wire === 2) {
      const len = varint(); if (i + len > frame.length) throw new Error('Truncated protobuf');
      if (field === 1) { if (name !== undefined) throw new Error('Duplicate tool name'); name = frame.subarray(i, i + len).toString('utf8'); }
      i += len;
    } else if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error('Unsupported protobuf field');
    if (i > frame.length) throw new Error('Truncated protobuf');
  }
  return name || '';
}
export function classifyRpc(path: string, frame: Buffer): 'read' | 'write' | 'deny' {
  const match = /^\/cua\.env\.v1\.([^?]+)$/.exec(path);
  const method = match?.[1];
  if (!method) return 'deny';
  if (method === 'DriverService/CallTool') {
    const name = toolName(frame);
    return readTools.has(name) ? 'read' : writeTools.has(name) ? 'write' : 'deny';
  }
  return readMethods.has(method) ? 'read' : writeMethods.has(method) ? 'write' : 'deny';
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
