import test from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyMediaRequest, rpcString } from './media-policy.js';
function frame(payload: Buffer) { const h = Buffer.alloc(5); h.writeUInt32BE(payload.length, 1); return Buffer.concat([h, payload]); }
test('media is always view-only and cannot acquire geometry authority through a duplicate field', () => {
 const input = frame(Buffer.from([24, 30, 48, 3, 56, 2, 48, 2]));
 const output = readOnlyMediaRequest('/cua.env.v1.StreamService/OpenMedia', input);
 assert.deepEqual(output.subarray(5), Buffer.from([24, 30, 48, 1, 56, 1]));
 assert.equal(output.readUInt32BE(1), 6);
 assert.deepEqual(readOnlyMediaRequest('/cua.env.v1.SystemService/CreateViewerTicket', frame(Buffer.from([16, 3, 24, 1]))).subarray(5), Buffer.from([24, 1, 16, 1]));
 assert.equal(readOnlyMediaRequest('/cua.env.v1.ComputerService/Pointer', input), input);
 assert.throws(() => readOnlyMediaRequest('/cua.env.v1.StreamService/OpenMedia', Buffer.from([0])));
 assert.equal(rpcString(frame(Buffer.from([10, 3, 97, 98, 99])), 1), 'abc');
});
