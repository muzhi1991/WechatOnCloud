// Native media sockets carry InteractiveInput too. The managed gateway offers
// observation streams only; input stays on the separately fenced GUI RPCs.
// Preserve all other protobuf fields byte-for-byte, including unknown fields.
function fields(message: Buffer): { field: number; wire: number; data: Buffer; bytes: Buffer }[] {
  let i = 0; const result: { field: number; wire: number; data: Buffer; bytes: Buffer }[] = [];
  const varint = () => { let n = 0, shift = 0; while (i < message.length && shift < 49) { const b = message[i++]; n += (b & 127) * 2 ** shift; if (!(b & 128)) return n; shift += 7; } throw Error('Invalid protobuf'); };
  while (i < message.length) {
    const start = i, tag = varint(), field = Math.floor(tag / 8), wire = tag & 7;
    let dataStart = i;
    if (!field) throw Error('Invalid protobuf field');
    if (wire === 0) varint();
    else if (wire === 2) { const size = varint(); dataStart = i; i += size; }
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw Error('Unsupported protobuf wire type');
    if (i > message.length) throw Error('Truncated protobuf');
    result.push({ field, wire, data: message.subarray(dataStart, i), bytes: message.subarray(start, i) });
  }
  return result;
}
export function readOnlyMediaRequest(path: string, frame: Buffer): Buffer {
  const overrides = path === '/cua.env.v1.StreamService/OpenMedia' ? [6, 7]
    : path === '/cua.env.v1.SystemService/CreateViewerTicket' ? [2] : [];
  if (!overrides.length) return frame;
  if (frame.length < 5 || frame[0] !== 0 || frame.readUInt32BE(1) !== frame.length - 5) throw Error('Expected unary media request');
  const payload = Buffer.concat([...fields(frame.subarray(5)).filter(f => !overrides.includes(f.field)).map(f => f.bytes),
    ...overrides.map(field => Buffer.from([field * 8, 1]))]); // VIEW_ONLY=1 / OBSERVE_ONLY=1
  const header = Buffer.alloc(5); header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
export function rpcString(response: Buffer, field: number): string | undefined {
  if (response.length < 5 || response[0] !== 0) return;
  const length = response.readUInt32BE(1);
  if (length > response.length - 5) return;
  return fields(response.subarray(5, 5 + length)).find(f => f.field === field && f.wire === 2)?.data.toString('utf8');
}
