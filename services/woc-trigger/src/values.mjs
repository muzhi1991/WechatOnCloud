import { Failure } from "./contracts.mjs";
const pattern = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
export const stringify = (v) => (typeof v === "string" ? v : JSON.stringify(v));
export function references(value) {
  return [...JSON.stringify(value).matchAll(pattern)].map((m) => m[1]);
}
export function resolve(value, context) {
  if (typeof value !== "string") return value;
  const lookup = (path) => {
    let v = context;
    for (const key of path.split(".")) {
      if (
        ["__proto__", "constructor", "prototype"].includes(key) ||
        v == null ||
        !Object.hasOwn(Object(v), key)
      )
        throw new Failure(`Variable unavailable: ${path}`);
      v = v[key];
    }
    return v;
  };
  const matches = [...value.matchAll(pattern)];
  if (matches.length === 1 && matches[0][0] === value) return lookup(matches[0][1]);
  return value.replace(pattern, (_, p) => stringify(lookup(p)));
}
export function output(text) {
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { text, json };
}
export function contextFor(run, steps, input) {
  const data = run.event.data || {};
  return {
    run: { id: run.id },
    trigger: {
      ...data,
      received_at: run.event.received_at,
      source: run.event.source,
      body: data,
      machine_id: data.machine_id || /^wechat:\/\/([^/]+)/.exec(data.uri || "")?.[1] || "",
    },
    input: output(input),
    steps,
  };
}
export function tailText(text, limit = 65536) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let start = bytes.length - limit;
  while ((bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}
