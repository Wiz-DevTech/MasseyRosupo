// End-to-end tests for the public instrument filing endpoint (the core feature).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const Database = require("better-sqlite3");
const { boot } = require("./harness");

let ctx;
const VALID = {
  documentType: "bill-of-exchange",
  title: "Test Bill of Exchange",
  amount: "1000",
  currency: "CIPR",
  parties: { drawer: "Test Drawer", drawee: "Test Drawee", payee: "WIBT" },
  memo: "hermetic test",
  entity: { name: "Test Entity", type: "LLC", ein: "12-3456789", address: "1 Test St", rep: "Rep", email: "test@example.com" },
};

before(async () => { ctx = await boot(); });
after(async () => { await ctx.cleanup(); });

test("POST /api/public/instruments — valid filing returns a minted Document ID", async () => {
  const r = await fetch(ctx.base + "/api/public/instruments", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(VALID),
  });
  assert.strictEqual(r.status, 201);
  const d = await r.json();
  assert.match(d.documentId, /^DOC-TEST-\d{12}$/);
  assert.match(d.sha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(d.status, "active");
  assert.strictEqual(d.anchor.status, "anchored"); // stub chain mines a block
  assert.match(d.anchor.blockHash, /^0xTESTBLOCK/);
  assert.ok(d.id);
  ctx.filedId = d.documentId;
});

test("validation: bad documentType -> 400", async () => {
  const r = await fetch(ctx.base + "/api/public/instruments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID, documentType: "nonsense" }),
  });
  assert.strictEqual(r.status, 400);
});

test("validation: negative amount -> 400", async () => {
  const r = await fetch(ctx.base + "/api/public/instruments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID, amount: "-5" }),
  });
  assert.strictEqual(r.status, 400);
});

test("validation: bad currency -> 400", async () => {
  const r = await fetch(ctx.base + "/api/public/instruments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID, currency: "EUR" }),
  });
  assert.strictEqual(r.status, 400);
});

test("validation: malformed wallet -> 400", async () => {
  const r = await fetch(ctx.base + "/api/public/instruments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID, entity: { ...VALID.entity, wallet: "not-a-wallet" } }),
  });
  assert.strictEqual(r.status, 400);
});

test("validation: missing entity email -> 400", async () => {
  const r = await fetch(ctx.base + "/api/public/instruments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID, entity: { ...VALID.entity, email: "" } }),
  });
  assert.strictEqual(r.status, 400);
});

test("idempotency: duplicate filing returns the SAME Document ID (200)", async () => {
  const r = await fetch(ctx.base + "/api/public/instruments", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(VALID),
  });
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.strictEqual(d.duplicate, true);
  assert.strictEqual(d.documentId, ctx.filedId);
});

test("data at rest: entity PII is encrypted in the DB", () => {
  const db = new Database(ctx.dbPath, { readonly: true });
  const row = db.prepare("SELECT entity FROM documents WHERE document_id = ?").get(ctx.filedId);
  const pegCols = db.prepare("PRAGMA table_info(documents)").all().map(c => c.name);
  db.close();
  assert.ok(row, "document row exists");
  assert.strictEqual(row.entity, "Test Entity", "entity NAME (non-PII) is plaintext");
  for (const c of ["peg_status", "anchor_block", "anchor_status"]) assert.ok(pegCols.includes(c), `column ${c} exists`);
});

test("audit trail: document.mint row recorded", () => {
  const db = new Database(ctx.dbPath, { readonly: true });
  const row = db.prepare("SELECT kind, ref, actor FROM audit_log WHERE kind = 'document.mint' ORDER BY id DESC LIMIT 1").get();
  db.close();
  assert.ok(row, "audit row exists");
  assert.strictEqual(row.ref, ctx.filedId);
});
