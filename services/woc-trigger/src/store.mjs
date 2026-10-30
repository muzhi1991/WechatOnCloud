import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Failure, validate, nextDue } from "./contracts.mjs";
const hash = (text) => createHash("sha256").update(text).digest("hex");
export class Store {
  constructor(path, connections = {}) {
    this.connections = connections;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS triggers(id TEXT PRIMARY KEY, config TEXT NOT NULL, secret_hash TEXT, due INTEGER, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, trigger_id TEXT, name TEXT, status TEXT NOT NULL, event TEXT NOT NULL, action TEXT NOT NULL, created INTEGER NOT NULL, started INTEGER, ended INTEGER, log TEXT NOT NULL DEFAULT '', result TEXT, FOREIGN KEY(trigger_id) REFERENCES triggers(id) ON DELETE SET NULL);
      CREATE INDEX IF NOT EXISTS runs_status ON runs(status, created);`);
    this.db
      .prepare(
        "UPDATE runs SET status='interrupted', ended=?, log=log || '\nDaemon stopped; execution outcome may be unknown. Not replayed.' WHERE status IN ('running','waiting')",
      )
      .run(Date.now());
    // Missed schedule occurrences are not replayed after restart.
    for (const t of this.list())
      this.db
        .prepare("UPDATE triggers SET due=? WHERE id=?")
        .run(t.enabled ? nextDue(t.source, Date.now()) : null, t.id);
  }
  list() {
    return this.db
      .prepare("SELECT * FROM triggers ORDER BY created DESC")
      .all()
      .map((r) => ({ id: r.id, ...JSON.parse(r.config), next_run: r.due }));
  }
  get(id) {
    return this.list().find((t) => t.id === id);
  }
  save(input, id) {
    const cfg = validate(input, this.connections);
    const previous = id && this.get(id);
    if (id && !previous) throw new Failure("Trigger not found", 404);
    if (!id && this.list().length >= 200) throw new Failure("Trigger limit reached", 409);
    id ||= randomUUID();
    const secret =
      (!previous && cfg.source.type === "webhook") ||
      (previous?.source.type !== "webhook" && cfg.source.type === "webhook")
        ? randomBytes(32).toString("hex")
        : null;
    if (
      previous &&
      this.db
        .prepare("SELECT id FROM runs WHERE trigger_id=? AND status IN ('running','waiting')")
        .get(id)
    )
      throw new Failure("Wait for the active run before editing", 409);
    this.db
      .prepare(
        "INSERT INTO triggers VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,due=excluded.due,secret_hash=COALESCE(excluded.secret_hash,triggers.secret_hash)",
      )
      .run(
        id,
        JSON.stringify(cfg),
        secret ? hash(secret) : null,
        cfg.enabled ? nextDue(cfg.source, Date.now()) : null,
        Date.now(),
      );
    if (!cfg.enabled)
      this.db
        .prepare("UPDATE runs SET status='canceled',ended=? WHERE trigger_id=? AND status='queued'")
        .run(Date.now(), id);
    return { ...this.get(id), ...(secret ? { webhook_secret: secret } : {}) };
  }
  remove(id) {
    if (
      this.db
        .prepare("SELECT id FROM runs WHERE trigger_id=? AND status IN ('running','waiting')")
        .get(id)
    )
      throw new Failure("Wait for the active run before deleting", 409);
    this.db
      .prepare("UPDATE runs SET status='canceled',ended=? WHERE trigger_id=? AND status='queued'")
      .run(Date.now(), id);
    this.db.prepare("DELETE FROM triggers WHERE id=?").run(id);
  }
  checkHook(id, secret) {
    const t = this.get(id);
    const r = this.db.prepare("SELECT secret_hash FROM triggers WHERE id=?").get(id);
    return t?.source.type === "webhook" && t.enabled && r?.secret_hash === hash(secret);
  }
  enqueue(id, data = {}, reason = "manual") {
    const t = this.get(id);
    if (!t) throw new Failure("Trigger not found", 404);
    if (!t.enabled && reason !== "manual") throw new Failure("Trigger paused", 409);
    const active = this.db
      .prepare(
        "SELECT id,status FROM runs WHERE trigger_id=? AND status IN ('queued','running','waiting') ORDER BY created",
      )
      .all(id);
    if (reason === "timer" && active.length) return { skipped: true };
    if (reason === "mcp" && active.some((r) => r.status === "queued")) return { coalesced: true };
    if (
      active.length >= 32 ||
      this.db
        .prepare("SELECT count(*) n FROM runs WHERE status IN ('queued','running','waiting')")
        .get().n >= 256
    )
      throw new Failure("Pending run limit reached", 429);
    const run = randomUUID(),
      now = Date.now(),
      event = {
        trigger_id: id,
        run_id: run,
        source: reason,
        received_at: new Date(now).toISOString(),
        data,
      };
    if (Buffer.byteLength(JSON.stringify(event)) > 65536)
      throw new Failure("Input exceeds 64 KiB", 413);
    this.db
      .prepare(
        "INSERT INTO runs(id,trigger_id,name,status,event,action,created) VALUES(?,?,?,?,?,?,?)",
      )
      .run(run, id, t.name, "queued", JSON.stringify(event), JSON.stringify(t.action), now);
    return { run_id: run, status: "queued" };
  }
  enqueueAgent(action, key) {
    if (action?.type !== "agent") throw new Failure("Expected agent action");
    const a = validate(
      { name: "Agent task", enabled: false, source: { type: "webhook" }, action },
      this.connections,
    ).action;
    const id = key ? hash(a.agent_id + ":" + key) : randomUUID();
    const old = this.run(id);
    if (old) return { run_id: id, status: old.status };
    if (
      this.db
        .prepare("SELECT count(*) n FROM runs WHERE status IN ('queued','running','waiting')")
        .get().n >= 256
    )
      throw new Failure("Pending run limit reached", 429);
    const event = {
      run_id: id,
      trigger_id: null,
      source: "script",
      received_at: new Date().toISOString(),
      data: {},
    };
    this.db
      .prepare("INSERT INTO runs(id,name,status,event,action,created) VALUES(?,?,?,?,?,?)")
      .run(id, "Agent task", "queued", JSON.stringify(event), JSON.stringify(a), Date.now());
    return { run_id: id, status: "queued" };
  }
  runs(id) {
    return this.db
      .prepare(
        `SELECT id,trigger_id,name,status,created,started,ended,result FROM runs ${id ? "WHERE trigger_id=?" : ""} ORDER BY created DESC LIMIT 100`,
      )
      .all(...(id ? [id] : []))
      .map((r) => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
  }
  run(id) {
    const r = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    return r
      ? {
          ...r,
          event: JSON.parse(r.event),
          action: JSON.parse(r.action),
          result: r.result ? JSON.parse(r.result) : null,
        }
      : null;
  }
  patch(id, status, { log = "", result = null } = {}) {
    this.db
      .prepare(
        "UPDATE runs SET status=?,started=COALESCE(started,?),ended=?,log=?,result=? WHERE id=?",
      )
      .run(
        status,
        Date.now(),
        ["running", "waiting"].includes(status) ? null : Date.now(),
        log.slice(-65536),
        result ? JSON.stringify(result) : null,
        id,
      );
  }
  sweep() {
    this.db
      .prepare(
        "DELETE FROM runs WHERE status NOT IN ('running','waiting','queued') AND (created < ? OR id NOT IN (SELECT id FROM runs ORDER BY created DESC LIMIT 1000))",
      )
      .run(Date.now() - 7 * 86400000);
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
  close() {
    this.db.close();
  }
}
