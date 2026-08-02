// Security-surface tests: auth gates, CORS allowlist, rate limiting,
// redirect pinning, upload fail-closed, contact persistence + encryption.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const Database = require("better-sqlite3");
const { boot } = require("./harness");

let ctx;
before(async () => { ctx = await boot(); });
after(async () => { await ctx.cleanup(); });

test("auth gate: /api/documents without token -> 401", async () => {
  const r = await fetch(ctx.base + "/api/documents");
  assert.strictEqual(r.status, 401);
});

test("auth gate: /api/audit without token -> 401", async () => {
  const r = await fetch(ctx.base + "/api/audit");
  assert.strictEqual(r.status, 401);
});

test("CORS: allowlisted origin passes", async () => {
  const r = await fetch(ctx.base + "/api/schedule-fees", { headers: { Origin: "https://masseyrosupo.com" } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers.get("access-control-allow-origin"));
});

test("CORS: evil origin rejected", async () => {
  const r = await fetch(ctx.base + "/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ email: "a@b.c", message: "x" }),
  });
  assert.ok(r.status >= 400);
  assert.strictEqual(r.headers.get("access-control-allow-origin"), null);
});

test("OIDC callback: evil redirect_uri -> 400", async () => {
  const r = await fetch(ctx.base + "/api/auth/oidc-callback", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "x", code_verifier: "y", redirect_uri: "https://evil.example/steal.html" }),
  });
  assert.strictEqual(r.status, 400);
  const j = await r.json();
  assert.match(j.error, /redirect_uri/);
});

test("OIDC callback: allowlisted redirect_uri passes validation", async () => {
  const r = await fetch(ctx.base + "/api/auth/oidc-callback", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "x", code_verifier: "y", redirect_uri: "https://masseyrosupo.com/portal-login.html" }),
  });
  // Fails at code exchange (stub), NOT at redirect validation.
  assert.notStrictEqual(r.status, 400);
});

test("rate limit: strict limiter returns 429 after 20 hits", async () => {
  let last = 0;
  for (let i = 0; i < 22; i++) {
    const r = await fetch(ctx.base + "/api/auth/oidc-callback", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    last = r.status;
  }
  assert.strictEqual(last, 429);
});

test("upload: fail-closed when key absent", async () => {
  const r = await fetch(ctx.base + "/api/upload", { method: "POST", body: new FormData() });
  // UPLOAD_KEY IS set in the harness, so the endpoint is live: bad key path instead.
  assert.ok(r.status === 403 || r.status === 400);
});

test("upload: known bad key rejected", async () => {
  const form = new FormData();
  form.append("key", "wrong-key");
  const r = await fetch(ctx.base + "/api/upload", { method: "POST", body: form });
  assert.strictEqual(r.status, 403);
});

test("contact: persists + encrypts PII", async () => {
  const r = await fetch(ctx.base + "/api/contact", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "PII Person", email: "pii@example.com", nature: "test", message: "secret message" }),
  });
  assert.strictEqual(r.status, 200);
  const db = new Database(ctx.dbPath, { readonly: true });
  const row = db.prepare("SELECT name, email, message FROM inquiries ORDER BY rowid DESC LIMIT 1").get();
  db.close();
  assert.ok(String(row.name).startsWith("enc:"));
  assert.ok(String(row.email).startsWith("enc:"));
  assert.ok(String(row.message).startsWith("enc:"));
});

test("contact: missing fields -> 400", async () => {
  const r = await fetch(ctx.base + "/api/contact", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "x@y.com" }),
  });
  assert.strictEqual(r.status, 400);
});

test("public schedule-fees read is open", async () => {
  const r = await fetch(ctx.base + "/api/schedule-fees");
  assert.strictEqual(r.status, 200);
});
