// Massey & Rosupo Co. — Backend API
// Node.js + Express + SQLite (better-sqlite3)
//
// Responsibilities:
//   1. OIDC Authorization-Code + PKCE callback for BOTH M&R portals:
//        - Trustee portal   -> Keycloak client `massey-admin`   (role: trustee)
//        - Client portal     -> Keycloak client `massey-client`  (role: beneficiary)
//      Ported from wisdom-backend's proven /api/auth/oidc-callback.
//   2. Operations & Arbitration APIs. The substantial logic + wisdomignited
//      links live on the upstream wisdomignited backend; this service proxies
//      and augments them for M&R, and stores M&R-local records in SQLite.
//   3. Local data: forms library, state/federal DB catalogs, filings,
//      arbitration cases, operation records.

require("dotenv").config();
const express = require("express");
const Database = require("better-sqlite3");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const helmet = require("helmet");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3009;
// Trust the single reverse-proxy hop so req.ip / rate-limit keys see the real
// client IP (Cloudflare -> nginx-proxy -> this app). Required for the public
// filing limiter to work per-visitor instead of one shared bucket.
app.set("trust proxy", 1);

// ── Keycloak config (CipherNex hub realm, shared) ────────────────────────────
const KC_URL = process.env.KC_URL || "http://keycloak-ciphernex:8080";
const KC_REALM = process.env.KC_REALM || "ciphernex";

// Trustee portal
const KC_CLIENT_TRUSTEE = process.env.KC_CLIENT_TRUSTEE || "massey-admin";
const KC_REQUIRED_ROLE_TRUSTEE = process.env.KC_REQUIRED_ROLE_TRUSTEE || "trustee";
const KC_REDIRECT_TRUSTEE = process.env.KC_REDIRECT_TRUSTEE || "https://masseyrosupo.com/admin-portal.html";
// Client portal (beneficiaries)
const KC_CLIENT_CLIENT = process.env.KC_CLIENT_CLIENT || "massey-client";
const KC_REQUIRED_ROLE_CLIENT = process.env.KC_REQUIRED_ROLE_CLIENT || "beneficiary";
const KC_REDIRECT_CLIENT = process.env.KC_REDIRECT_CLIENT || "https://masseyrosupo.com/portal-login.html";

const WISDOM_BACKEND_API = process.env.WISDOM_BACKEND_API || "https://wisdomignited.com/api";
const mailer = require("./mailer");

// ── CipherNex DocumentService (mints on-chain Document IDs) ───────────────────
const CIPHERNEX_DOCS_API = process.env.CIPHERNEX_DOCS_API || "http://localhost:3004";
// Local secure storage for uploaded document binaries.
const DOC_STORE_DIR = process.env.DOC_STORE_DIR || path.join(__dirname, "doc-store");
fs.mkdirSync(DOC_STORE_DIR, { recursive: true });

// ── SQLite ───────────────────────────────────────────────────────────────────
const DB_PATH = process.env.MR_DB || path.join(__dirname, "masseyrosupo.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS forms (
    id TEXT PRIMARY KEY,
    category TEXT,          -- 'ucc' | 'state' | 'federal' | 'international'
    title TEXT,
    description TEXT,
    body TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS filings (
    id TEXT PRIMARY KEY,
    type TEXT,              -- 'UCC-1' | 'CIPR' | 'reserve' | ...
    reference TEXT,
    status TEXT,
    payload TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS schedule_fees (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE,        -- 'FS-01' .. 'FS-50'
    category TEXT,           -- 'trespass' | 'fraud' | 'rights' | 'court' | 'harassment' | 'process' | 'property'
    name TEXT,
    amount INTEGER,          -- fee in (the schedule's) dollar units
    per TEXT,                -- 'per occurrence' | 'per violation' | ...
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    kind TEXT,              -- 'ledger' | 'reserve' | 'instrument' | ...
    reference TEXT,
    status TEXT,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS arbitrations (
    id TEXT PRIMARY KEY,
    case_ref TEXT,            -- human case id (MRSP-xxxx)
    claimant TEXT,            -- filing party (defaults to logged-in account)
    respondent TEXT,
    entity TEXT,              -- respondent entity type
    address TEXT,             -- respondent address
    agreement TEXT,           -- agreement type / clause reference
    commerce TEXT,            -- interstate commerce nexus
    violations TEXT,          -- JSON array of {code,name,amount,count,subtotal}
    total TEXT,               -- claim total (numeric string)
    status TEXT,              -- NOTICE_PENDING|HEARING|AWARDED|PENDING_90DAY|RECEIVABLE|SETTLED
    clause TEXT,              -- binding arbitration clause text
    detail TEXT,
    award_date TEXT,          -- ISO date award issued (for 90-day bar)
    bar_date TEXT,            -- ISO date absolute bar expires
    owner_sub TEXT,           -- Keycloak user sub (account association)
    owner_name TEXT,          -- Keycloak preferred_username / display
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,           -- local uuid (gateway surrogate)
    document_id TEXT,              -- CipherNex on-chain Document ID (FK / source of truth)
    stored_name TEXT,              -- name on disk in DOC_STORE_DIR (local file pointer)
    filename TEXT,                 -- original upload name (display-only convenience)
    visibility TEXT,               -- 'public' | 'private'  (gateway access-control policy)
    entity TEXT,                   -- owning client/entity (gateway view-scoping)
    uploaded_by TEXT,              -- trustee sub (gateway audit)
    title TEXT,
    document_type TEXT,
    mime TEXT,
    size INTEGER,
    sha256 TEXT,
    status TEXT,                   -- 'active' | 'retired' | 'rejected'
    amount TEXT,
    currency TEXT,
    parties TEXT,                  -- JSON { drawer, drawee, payee }
    memo TEXT,
    chain_receipt TEXT,            -- JSON of CipherNex create response
    peg_type TEXT,                 -- 1:1 value peg (asset/source/ref)
    peg_ref TEXT,
    peg_status TEXT,               -- 'PEGGED' | 'PEG_DRIFT' | 'UNPEGGED'
    peg_ratio TEXT,
    peg_verified_at TEXT,
    anchor_block TEXT,             -- on-chain anchor block hash (best-effort)
    anchor_status TEXT,            -- 'anchored' | 'queued'
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS inquiries (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    nature TEXT,
    message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    actor TEXT,
    kind TEXT,
    ref TEXT,
    detail TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_document_id ON documents(document_id);
`);

// ── Migration: ensure arbitration columns exist (idempotent) ──────────────────
// Older DBs were created with the thin schema; add the richer case columns
// without dropping existing data.
(function migrateArbitrations(){
  const cols = db.prepare("PRAGMA table_info(arbitrations)").all().map(c => c.name);
  const want = ["entity","address","agreement","commerce","violations","total","award_date","bar_date","owner_sub","owner_name","beneficiary_sub"];
  for (const c of want) {
    if (!cols.includes(c)) db.prepare(`ALTER TABLE arbitrations ADD COLUMN ${c} TEXT`).run();
  }
})();

// ── Migration: documents get the 1:1 value-peg block (2026-08-02) ────────────
(function migrateDocumentsPeg(){
  const cols = db.prepare("PRAGMA table_info(documents)").all().map(c => c.name);
  const want = ["peg_type","peg_ref","peg_status","peg_ratio","peg_verified_at","anchor_block","anchor_status"];
  for (const c of want) {
    if (!cols.includes(c)) db.prepare(`ALTER TABLE documents ADD COLUMN ${c} TEXT`).run();
  }
})();

// ── Migration: ensure the rich documents schema on pre-existing thin tables ──
// The live DB (created 2026-07-12) predates the rich INSERT (P1-07) and the
// CREATE TABLE fix; this backfills it additively without touching existing rows.
(function migrateDocumentsRich(){
  const cols = db.prepare("PRAGMA table_info(documents)").all().map(c => c.name);
  const want = ["title","document_type","mime","size","sha256","status","amount","currency","parties","memo","chain_receipt",
                "peg_type","peg_ref","peg_status","peg_ratio","peg_verified_at","anchor_block","anchor_status"];
  for (const c of want) {
    if (!cols.includes(c)) db.prepare(`ALTER TABLE documents ADD COLUMN ${c} TEXT`).run();
  }
})();

// ── Middleware ────────────────────────────────────────────────────────────────
// CSP disabled here: the site uses inline styles/scripts, Google Fonts, and a
// cross-origin Keycloak redirect. helmet's default CSP would break the look.
app.use(helmet({ contentSecurityPolicy: false }));

// ── CORS allowlist (P1-14 remediation 2026-08-02): explicit origins only.
// No reflect-any-origin; keeps credentials:true for the PKCE flows that need it.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ||
  "https://masseyrosupo.com,https://www.masseyrosupo.com,https://massey-api.wisdomignited.com,http://localhost:3019,http://127.0.0.1:3019,http://95.217.151.38:3019"
).split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed by CORS policy"));
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));

// ── Rate limiting (P1-06 remediation 2026-08-02). Public/unauthenticated
// write paths get strict limits; authenticated APIs get a generous ceiling.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests — please try again in 15 minutes" },
});
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests — please try again in 15 minutes" },
});
const auditLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests" } });
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many filings — please try again later" },
  keyGenerator: (req) => req.headers["cf-connecting-ip"] || req.headers["x-real-ip"] || ipKeyGenerator(req.ip),
});

// ── Service credential for the public filing endpoint (massey-public-mint) ──
// Client-credentials token (Keycloak, realm ciphernex, trustee role) so the
// backend can mint documents on :3004 on behalf of public visitors. Cached 4min.
const KC_SERVICE_CLIENT = process.env.KC_SERVICE_CLIENT || "";
const KC_SERVICE_SECRET = process.env.KC_SERVICE_SECRET || "";
let _svcToken = null, _svcTokenAt = 0;
async function getServiceToken() {
  if (!KC_SERVICE_CLIENT || !KC_SERVICE_SECRET) return null;
  if (_svcToken && Date.now() - _svcTokenAt < 240000) return _svcToken;
  try {
    const r = await fetch(`${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: KC_SERVICE_CLIENT, client_secret: KC_SERVICE_SECRET }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    _svcToken = j.access_token; _svcTokenAt = Date.now();
    return _svcToken;
  } catch (e) { return null; }
}

// Verify a Keycloak access token (RS256, hub realm). Returns decoded payload.
let _kcPubKey = null, _kcPubKeyAt = 0;
async function verifyKeycloakToken(token) {
  try {
    // Cache the realm public key (PEM) for 10 minutes.
    if (!_kcPubKey || Date.now() - _kcPubKeyAt > 600000) {
      const jwksRes = await fetch(`${KC_URL}/realms/${KC_REALM}`);
      const realm = await jwksRes.json();
      _kcPubKey = `-----BEGIN PUBLIC KEY-----\n${realm.public_key}\n-----END PUBLIC KEY-----`;
      _kcPubKeyAt = Date.now();
    }
    const decoded = jwt.verify(token, _kcPubKey, { algorithms: ["RS256"] });
    return decoded;
  } catch (e) {
    return null;
  }
}

// Generic auth middleware (any valid Keycloak token).
const auth = async (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  const decoded = await verifyKeycloakToken(token);
  if (!decoded) return res.status(401).json({ error: "Invalid token" });
  req.user = decoded;
  next();
};

// Role-gated auth middleware factory.
function requireRole(role) {
  return async (req, res, next) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "No token" });
    const decoded = await verifyKeycloakToken(token);
    if (!decoded) return res.status(401).json({ error: "Invalid token" });
    const roles = (decoded.realm_access && decoded.realm_access.roles) || [];
    if (!roles.includes(role)) return res.status(403).json({ error: "Insufficient role" });
    req.user = decoded;
    next();
  };
}

// ── At-rest encryption (SEC-3): AES-256-GCM for PII fields ────────────────
// ENCRYPTION_KEY must be 64 hex chars. Rows are stored as
// "enc:<iv b64>:<ct b64>:<authTag b64>"; anything else stays plaintext.
const CRYPTO_KEY = Buffer.from(String(process.env.ENCRYPTION_KEY || "").padEnd(64, "0").slice(0, 64), "hex");
function encPII(s) {
  if (!s) return s;
  try {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", CRYPTO_KEY, iv);
    const ct = Buffer.concat([c.update(String(s), "utf8"), c.final()]);
    return "enc:" + iv.toString("base64") + ":" + ct.toString("base64") + ":" + c.getAuthTag().toString("base64");
  } catch (e) {
    return s; // never break a write because encryption failed
  }
}
function decPII(s) {
  if (!s || !String(s).startsWith("enc:")) return s;
  try {
    const [ivB, ctB, tagB] = String(s).slice(4).split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", CRYPTO_KEY, Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
  } catch (e) {
    return s;
  }
}

// ── Audit trail (P3-26 remediation 2026-08-02) ──────────────────────────────
function logAudit(kind, ref, detail, actor) {
  try {
    db.prepare("INSERT INTO audit_log (actor, kind, ref, detail) VALUES (?,?,?,?)")
      .run(actor || "public", kind || "", ref || "", String(detail || "").slice(0, 500));
  } catch (e) { /* never break a request because logging failed */ }
}
// Catch-all: every mutating /api call lands an audit row (actor is enriched
// per-handler on the money paths: document mint/retire, arbitration writes).
app.use((req, res, next) => {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && req.path.startsWith("/api")) {
    logAudit("http." + req.method.toLowerCase(), req.path,
      JSON.stringify(req.body || {}).slice(0, 300), req.user?.sub || "public");
  }
  next();
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, service: "masseyrosupo-backend" }));

// ── Audit trail read-back (P3-26): trustee-only, most recent 200 entries ─────
app.get("/api/audit", requireRole(KC_REQUIRED_ROLE_TRUSTEE), (req, res) => {
  res.json(db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200").all());
});

// ── OIDC callback (ported from wisdom-backend) ───────────────────────────────
// Exchanges `code` + `code_verifier` for a Keycloak token, role-checks, returns
// the access token. `portal` selects which M&R client/role applies.
app.post("/api/auth/oidc-callback", strictLimiter, async (req, res) => {
  const { code, code_verifier, redirect_uri, portal } = req.body;
  if (!code || !code_verifier) return res.status(400).json({ error: "missing code" });

  const isClient = portal === "client";
  // P2-21 remediation: pin redirect_uri to registered origins/pages. The body
  // value is still honored (Keycloak requires the exact URI from the auth
  // request) but only when it parses to an allowlisted origin and a plain
  // .html path — arbitrary values are rejected outright.
  const allowedRedirects = (process.env.KC_ALLOWED_REDIRECTS ||
    "https://masseyrosupo.com,https://www.masseyrosupo.com,http://localhost:3019,http://127.0.0.1:3019"
  ).split(",").map(s => s.trim());
  if (redirect_uri) {
    let u = null;
    try { u = new URL(redirect_uri); } catch (e) { u = null; }
    if (!u || !allowedRedirects.includes(u.origin) || !/^\/[a-zA-Z0-9\-_]*\.html$/.test(u.pathname)) {
      return res.status(400).json({ error: "redirect_uri not allowed" });
    }
  }
  const clientId = isClient ? KC_CLIENT_CLIENT : KC_CLIENT_TRUSTEE;
  const requiredRole = isClient ? KC_REQUIRED_ROLE_CLIENT : KC_REQUIRED_ROLE_TRUSTEE;
  const fallbackRedirect = isClient ? KC_REDIRECT_CLIENT : KC_REDIRECT_TRUSTEE;

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier,
      redirect_uri: redirect_uri || fallbackRedirect,
    });
    const r = await fetch(`${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!r.ok) return res.status(401).json({ error: "code exchange failed" });
    const tok = await r.json();
    const payload = JSON.parse(Buffer.from(tok.access_token.split(".")[1], "base64").toString("utf8"));
    const roles = (payload.realm_access && payload.realm_access.roles) || [];
    if (!roles.includes(requiredRole)) {
      return res.status(403).json({ error: isClient ? "Account is not a beneficiary" : "Account is not a Trustee" });
    }
    return res.json({
      token: tok.access_token,
      idToken: tok.id_token,
      username: payload.preferred_username || payload.sub,
      roles,
      portal: isClient ? "client" : "trustee",
      via: "keycloak-oidc",
    });
  } catch (e) {
    return res.status(503).json({ error: "Identity service unavailable" });
  }
});

// ── Operations API (proxies to wisdomignited backend; M&R-local records too) ──
// The substantial Operations APIs + wisdomignited links live upstream.
// Operations ledger is fiduciary — trustee-only read (matches POST).
let _opsCache = { at: 0, data: null };
app.get("/api/operations", requireRole(KC_REQUIRED_ROLE_TRUSTEE), async (req, res) => {
  const local = db.prepare("SELECT * FROM operations ORDER BY created_at DESC").all();
  // SYNC-1 remediation: 60s TTL read-through cache for the upstream status sync
  // (SLA: upstream changes reflect within ≤60s; no push/webhook yet).
  try {
    let up = null;
    if (_opsCache.at && Date.now() - _opsCache.at < 60000) {
      up = _opsCache.data;
    } else {
      const upstream = await fetch(`${WISDOM_BACKEND_API}/operations`, {
        headers: { Authorization: req.headers.authorization || "" },
      });
      up = upstream.ok ? await upstream.json() : [];
      _opsCache = { at: Date.now(), data: up };
    }
    res.json({ local, upstream: up, sync: "cache-ttl-60s" });
  } catch (e) {
    if (_opsCache.at) return res.json({ local, upstream: _opsCache.data, sync: "cache-stale" });
    res.json({ local, upstream: [], note: "upstream unavailable" });
  }
});

app.post("/api/operations", requireRole(KC_REQUIRED_ROLE_TRUSTEE), (req, res) => {
  const id = uuidv4();
  const { kind, reference, status, detail } = req.body;
  db.prepare("INSERT INTO operations (id, kind, reference, status, detail) VALUES (?,?,?,?,?)")
    .run(id, kind, reference, status || "open", detail || "");
  res.json({ id, ok: true });
});

// ── Arbitration API ──────────────────────────────────────────────────────────
// Trustee-only governance instrument. Filing + status updates require the
// `trustee` realm role. Viewing (GET) is open to any authenticated account and
// is scope-limited: a trustee sees every case; a beneficiary (client) sees only
// the cases associated with their own account (owner_sub). This powers the
// read-only beneficiary "my cases" dashboard while keeping filing trustee-gated.
app.get("/api/arbitration", auth, async (req, res) => {
  try {
    const roles = (req.user?.realm_access && req.user.realm_access.roles) || [];
    const isTrustee = roles.includes(KC_REQUIRED_ROLE_TRUSTEE);
    const rows = isTrustee
      ? db.prepare("SELECT * FROM arbitrations ORDER BY created_at DESC").all()
      : db.prepare("SELECT * FROM arbitrations WHERE owner_sub = ? OR beneficiary_sub = ? ORDER BY created_at DESC")
          .all(req.user?.sub || "", req.user?.sub || "");
    return res.json({ cases: rows, scope: isTrustee ? "trustee:all" : "client:own", upstream: [] });
  } catch (e) {
    return res.status(500).json({ error: "list failed", detail: e.message });
  }
});

// POST a new arbitration case. Trustee-only. owner_sub is stamped server-side
// from the verified token (never trusted from the body) for audit trail.
app.post("/api/arbitration", requireRole(KC_REQUIRED_ROLE_TRUSTEE), (req, res) => {
  const id = uuidv4();
  const {
    case_ref, claimant, respondent, entity, address, agreement, commerce,
    violations, total, status, clause, detail, beneficiary_sub,
  } = req.body || {};
  if (!respondent) return res.status(400).json({ error: "respondent is required" });
  // BIZ-6 remediation: block arbitration against a discharged or unknown instrument.
  const linkedDocId = req.body?.documentId;
  if (linkedDocId) {
    const ld = db.prepare("SELECT * FROM documents WHERE document_id = ?").get(linkedDocId);
    if (!ld) return res.status(400).json({ error: "referenced instrument not found" });
    if (ld.status === "retired") return res.status(409).json({ error: "instrument is discharged — arbitration against it is blocked" });
  }
  const owner_sub = req.user?.sub || "";
  const owner_name = req.user?.preferred_username || req.user?.email || owner_sub;
  db.prepare(`INSERT INTO arbitrations
    (id, case_ref, claimant, respondent, entity, address, agreement, commerce,
     violations, total, status, clause, detail, owner_sub, owner_name, beneficiary_sub)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id,
    case_ref || null,
    claimant || owner_name,
    respondent,
    entity || null,
    address || null,
    agreement || null,
    commerce || null,
    violations ? JSON.stringify(violations) : null,
    total != null ? String(total) : "0",
    status || "NOTICE_PENDING",
    clause || "",
    detail || "",
    owner_sub,
    owner_name,
    beneficiary_sub || null
  );
  logAudit("arbitration.create", case_ref || id, `respondent: ${respondent}`, owner_sub);
  return res.status(201).json({ id, ok: true, scope: "trustee" });
});

// PATCH /api/arbitration/:id — trustee-only status / award / bar-date updates.
app.patch("/api/arbitration/:id", requireRole(KC_REQUIRED_ROLE_TRUSTEE), (req, res) => {
  const row = db.prepare("SELECT * FROM arbitrations WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "case not found" });
  const { status, award_date, bar_date, detail } = req.body || {};
  db.prepare(`UPDATE arbitrations
    SET status = COALESCE(?, status),
        award_date = COALESCE(?, award_date),
        bar_date = COALESCE(?, bar_date),
        detail = COALESCE(?, detail)
    WHERE id = ?`)
    .run(
      status || null,
      award_date || null,
      bar_date || null,
      detail || null,
      req.params.id
    );
  return res.json({ id: req.params.id, ok: true });
});

// ── Forms library (state/federal/international) ──────────────────────────────
app.get("/api/forms", (req, res) => {
  const { category } = req.query;
  const rows = category
    ? db.prepare("SELECT * FROM forms WHERE category = ?").all(category)
    : db.prepare("SELECT * FROM forms ORDER BY category").all();
  res.json(rows);
});

// ── Schedule A fee schedule (FAA 50-category liability schedule) ───────────────
// Read is open (any visitor / signed-in user can view the schedule). Writes
// (add/edit/remove a fee line) are trustee-only, matching the M&R access model.
app.get("/api/schedule-fees", (req, res) => {
  const rows = db.prepare("SELECT * FROM schedule_fees ORDER BY code").all();
  res.json(rows);
});
app.post("/api/schedule-fees", requireRole(KC_REQUIRED_ROLE_TRUSTEE), (req, res) => {
  const { code, category, name, amount, per } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: "code and name are required" });
  const id = uuidv4();
  db.prepare("INSERT OR REPLACE INTO schedule_fees (id, code, category, name, amount, per) VALUES (?,?,?,?,?,?)")
    .run(id, code, category || "misc", name, parseInt(amount) || 0, per || "per occurrence");
  res.json({ id, ok: true });
});
app.delete("/api/schedule-fees/:code", requireRole(KC_REQUIRED_ROLE_TRUSTEE), (req, res) => {
  db.prepare("DELETE FROM schedule_fees WHERE code = ?").run(req.params.code);
  res.json({ ok: true });
});

// ── Filings ───────────────────────────────────────────────────────────────────
app.get("/api/filings", requireRole(KC_REQUIRED_ROLE_TRUSTEE), (req, res) => {
  res.json(db.prepare("SELECT * FROM filings ORDER BY created_at DESC").all());
});
app.post("/api/filings", requireRole(KC_REQUIRED_ROLE_TRUSTEE), (req, res) => {
  const id = uuidv4();
  const { type, reference, status, payload } = req.body;
  db.prepare("INSERT INTO filings (id, type, reference, status, payload) VALUES (?,?,?,?,?)")
    .run(id, type, reference, status || "submitted", payload ? JSON.stringify(payload) : "");
  res.json({ id, ok: true });
});

// ── Documents: upload → SHA-256 → CipherNex mint → track ─────────────────────
// Trustee-only upload. The uploaded binary is stored on the M&R server; its
// SHA-256 is bound into the CipherNex document record (on-chain Document ID).
// Clients can view their own + public documents. Anyone can track a PUBLIC doc
// by its CipherNex Document ID.
const multer = require("multer");
const crypto = require("crypto");
const docUpload = multer({ dest: DOC_STORE_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

// Valid CipherNex document types (mirror of DocumentService DOCUMENT_TYPES)
const DOC_TYPES = [
  "bill-of-exchange", "trust-bond", "indemnity", "reserve-pledge",
  "promissory-note", "court-order", "trust-instrument",
];

// POST /api/documents — trustee uploads a file; we mint a CipherNex Document ID.
app.post("/api/documents", requireRole(KC_REQUIRED_ROLE_TRUSTEE), docUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file is required (multipart field 'file')" });
    const {
      title, documentType, amount = "0", currency = "CIPR",
      visibility = "private", entity = "", memo = "",
      drawer = "", drawee = "", payee = "", walletAddress = "",
    } = req.body || {};

    if (!title || !documentType) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "title and documentType are required", validTypes: DOC_TYPES });
    }
    if (!DOC_TYPES.includes(documentType)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "Invalid documentType", validTypes: DOC_TYPES });
    }

    // 1. Compute SHA-256 of the uploaded file (tamper-proof fingerprint).
    const buf = fs.readFileSync(req.file.path);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

    // 1b. Idempotency guard (P1-07 remediation): same SHA-256 = same instrument.
    //     A duplicate submission returns the existing Document ID instead of
    //     minting a second on-chain record.
    const dup = db.prepare("SELECT * FROM documents WHERE sha256 = ? AND status = 'active'").get(sha256);
    if (dup) {
      fs.unlink(req.file.path, () => {});
      logAudit("document.mint", dup.document_id, "duplicate suppressed (sha256 match)", req.user?.sub || "");
      return res.status(200).json({ ok: true, id: dup.id, documentId: dup.document_id, sha256, duplicate: true, note: "Instrument already registered — returned existing Document ID." });
    }

    // 1c. Validation (DI-2/SEC-2 remediation): amount/currency/wallet checked
    //     server-side — never trust client-side checks for ledger-bound values.
    if (!/^\d+(\.\d{1,8})?$/.test(String(amount))) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "amount must be a positive number (max 8 decimals)" });
    }
    if (!["CIPR", "USD", "XRP"].includes(String(currency).toUpperCase())) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "currency must be CIPR, USD, or XRP" });
    }
    if (walletAddress) {
      const wal = String(walletAddress).trim();
      if (!/^(r[1-9A-HJ-NP-Za-km-z]{24,34}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(wal)) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "walletAddress format invalid (expected XRP r-address or BTC address)" });
      }
    }
    // 1d. Discharge guard (BIZ-5): a settled instrument cannot be re-registered.
    const retired = db.prepare("SELECT * FROM documents WHERE sha256 = ? AND status = 'retired'").get(sha256);
    if (retired) {
      fs.unlink(req.file.path, () => {});
      return res.status(409).json({ error: "Instrument previously discharged — re-registration of a settled Document ID is blocked" });
    }

    // 2. Mint the CipherNex Document ID — forward the trustee's Keycloak token.
    const parties = { drawer: drawer || "Massey & Rosupo Co.", drawee, payee };
    const mintBody = {
      documentType, title, amount: String(amount), currency, parties,
      sha256,
      memo,
    };
    let chainReceipt = null, documentId = null;
    try {
      const r = await fetch(`${CIPHERNEX_DOCS_API}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: req.headers.authorization || "" },
        body: JSON.stringify(mintBody),
      });
      chainReceipt = await r.json();
      if (!r.ok) {
        fs.unlink(req.file.path, () => {});
        return res.status(502).json({ error: "CipherNex mint failed", detail: chainReceipt });
      }
      documentId = chainReceipt.documentId;
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      return res.status(502).json({ error: "CipherNex unreachable", detail: e.message });
    }

    // 3. Persist the LOCAL record — gateway-local fields plus the fields the
    //    schema defines (fixes the insert/schema drift found in the audit).
    //    CipherNex remains source of truth for chain status; local row now
    //    carries title/type/sha256/amount so it is not blank when :3004 is down.
    const id = uuidv4();
    db.prepare(`INSERT INTO documents
      (id, document_id, stored_name, filename, visibility, entity, uploaded_by,
       title, document_type, mime, size, sha256, status, amount, currency, parties, memo, chain_receipt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, documentId, path.basename(req.file.path), req.file.originalname,
      visibility === "public" ? "public" : "private", entity, req.user?.sub || "trustee",
      title, documentType, req.file.mimetype, req.file.size, sha256, "active",
      String(amount), currency, JSON.stringify(parties), memo, JSON.stringify(chainReceipt || {})
    );
    logAudit("document.mint", documentId, `${documentType} ${title}`, req.user?.sub || "");
    // NOTIF-2: notify trustees a new instrument awaits review (best-effort).
    mailer.send(mailer.TRUSTEES.join(","),
      `[M&R] New instrument registered: ${documentId}`,
      `A new instrument was registered:\n\n  Document ID: ${documentId}\n  Type: ${documentType}\n  Title: ${title}\n  Amount: ${amount} ${currency}\n  SHA-256: ${sha256}\n\nReview it in MainAccessDash.`);

    res.status(201).json({
      ok: true, id, documentId, sha256,
      title, documentType, visibility, status: "active",
      note: "File stored securely; SHA-256 bound to on-chain CipherNex Document ID.",
    });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: "Upload failed", detail: err.message });
  }
});

// GET /api/documents — trustee: all; client: own entity + public.
// Local rows are enriched with authoritative detail fetched from CipherNex
// (CipherNex is the single source of truth for title/type/parties/status/sha256).
app.get("/api/documents", auth, async (req, res) => {
  try {
    const roles = (req.user?.realm_access && req.user.realm_access.roles) || [];
    const isTrustee = roles.includes(KC_REQUIRED_ROLE_TRUSTEE);
    const rows = isTrustee
      ? db.prepare("SELECT * FROM documents ORDER BY created_at DESC").all()
      : db.prepare("SELECT * FROM documents WHERE visibility='public' OR entity=? ORDER BY created_at DESC")
          .all(req.user?.preferred_username || req.user?.sub || "");
    const enriched = await Promise.all(rows.map(enrichWithCiphernex));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: "list failed", detail: e.message }); }
});

// GET /api/documents/public/:documentId — anyone can track a PUBLIC document.
app.get("/api/documents/public/:documentId", async (req, res) => {
  const row = db.prepare("SELECT * FROM documents WHERE document_id=? AND visibility='public'").get(req.params.documentId);
  if (!row) return res.status(404).json({ error: "Public document not found" });
  res.json(await enrichWithCiphernex(row));
});

// GET /api/documents/:id/download — trustee, or client on own/public doc.
app.get("/api/documents/:id/download", auth, (req, res) => {
  const row = db.prepare("SELECT * FROM documents WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const roles = (req.user?.realm_access && req.user.realm_access.roles) || [];
  const isTrustee = roles.includes(KC_REQUIRED_ROLE_TRUSTEE);
  const owns = row.entity && row.entity === (req.user?.preferred_username || req.user?.sub);
  if (!isTrustee && row.visibility !== "public" && !owns) {
    return res.status(403).json({ error: "Not authorized for this document" });
  }
  const p = path.join(DOC_STORE_DIR, row.stored_name);
  if (!fs.existsSync(p)) return res.status(410).json({ error: "File missing on server" });
  res.download(p, row.filename);
});

// PATCH /api/documents/:id/retire — trustee settles/discharges the record.
app.patch("/api/documents/:id/retire", requireRole(KC_REQUIRED_ROLE_TRUSTEE), async (req, res) => {
  const row = db.prepare("SELECT * FROM documents WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  try {
    const r = await fetch(`${CIPHERNEX_DOCS_API}/documents/${row.document_id}/retire`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: req.headers.authorization || "" },
      body: JSON.stringify({ settlementMemo: req.body?.settlementMemo || "" }),
    });
    const chain = await r.json();
    if (!r.ok) return res.status(502).json({ error: "CipherNex retire failed", detail: chain });
  } catch (e) {
    return res.status(502).json({ error: "CipherNex unreachable", detail: e.message });
  }
  // Status lives in CipherNex (source of truth); local row only tracks gateway fields.
  res.json({ ok: true, id: req.params.id, status: "retired" });
});

// PATCH /api/documents/:id/reject — trustee rejects a submission (WF1-1).
// Local status flips to 'rejected' with an audit row; rejected documents are
// never minted chain-side by this path, so the entity sees a clear terminal
// state instead of hanging in limbo.
app.patch("/api/documents/:id/reject", requireRole(KC_REQUIRED_ROLE_TRUSTEE), (req, res) => {
  const row = db.prepare("SELECT * FROM documents WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE documents SET status='rejected' WHERE id=?").run(req.params.id);
  logAudit("document.reject", row.document_id, String(req.body?.reason || "").slice(0, 300), req.user?.sub || "");
  res.json({ ok: true, id: req.params.id, status: "rejected" });
});

// Enrich a local gateway row with authoritative detail from CipherNex.
// CipherNex is the single source of truth for title/type/parties/amount/status/sha256.
async function enrichWithCiphernex(r) {
  const base = {
    id: r.id, documentId: r.document_id,
    visibility: r.visibility, entity: r.entity, uploadedBy: r.uploaded_by,
    filename: r.filename, createdAt: r.created_at,
  };
  try {
    const res = await fetch(`${CIPHERNEX_DOCS_API}/documents/${r.document_id}`);
    if (!res.ok) return { ...base, status: "unknown", title: "(CipherNex unavailable)" };
    const d = await res.json();
    return {
      ...base,
      title: d.title, documentType: d.documentType,
      status: d.status, sha256: d.sha256 || "",
      amount: d.amount, currency: d.currency,
      parties: d.parties || {}, memo: d.memo,
    };
  } catch {
    return { ...base, status: "unknown", title: "(CipherNex unavailable)" };
  }
}

// ── Public site contact/document endpoint (replaces localhost:3005 dependency) ──
// P1-15 remediation: validated, persisted, rate-limited; SLA can now be tracked.
app.post("/api/contact", apiLimiter, async (req, res) => {
  const { name, email, nature, message } = req.body || {};
  if (!email || !message) return res.status(400).json({ error: "email and message are required" });
  const id = uuidv4();
  db.prepare("INSERT INTO inquiries (id, name, email, nature, message) VALUES (?,?,?,?,?)")
    .run(id,
      encPII(String(name || "").slice(0, 200)),
      encPII(String(email).slice(0, 200)),
      String(nature || "").slice(0, 100),
      encPII(String(message).slice(0, 4000)));
  console.log("[contact] inquiry", id, "from", email, "re:", nature);
  logAudit("inquiry.submit", id, `${email} re: ${nature || ""}`, "public");
  // NOTIF-1: auto-acknowledgment to the submitter (best-effort, gated by MAIL_ENABLED).
  mailer.send(String(email), "Massey & Rosupo — inquiry received",
    `Hi ${name || "there"},\n\nWe received your inquiry${nature ? " about " + nature : ""}. A trustee will respond within 2 business days.\n\nReference: ${id}\n\n— Massey & Rosupo Co.`);
  res.json({ ok: true, received: true, id });
});

// ── Public instrument filing — the site's core feature ───────────────────────
// POST /api/public/instruments — unauthenticated per the site's copy. Server
// derives the legal anchor (client value ignored), computes a deterministic
// SHA-256 for idempotency (P1-07), mints via the massey-public-mint service
// account, anchors the record on the CipherNex chain (best-effort), stores the
// local row with PII encrypted (SEC-3), and emails the entity the Document ID.
// Optional 1:1 value peg: { asset, source, address } verified via the chain API.
const ANCHOR_TEMPLATES = {
  'bill-of-exchange': 'UCC Article 3 — Negotiable Instruments. This Bill of Exchange is issued pursuant to UCC §3-104 and is subject to discharge under §3-311 (Accord and Satisfaction) or §3-603 (Tender of Payment). Perfected security interest registered under UCC-1 with Delaware SOS.',
  'promissory-note':  'UCC Article 3 — Negotiable Instruments. This Promissory Note constitutes an unconditional promise to pay a fixed sum. Subject to all rights and remedies under Delaware UCC Article 3. UCC-1 financing statement filed.',
  'trust-bond':       'This Trust Bond is issued under the authority of the governing Trust Instrument and Delaware Statutory Trust Act, 12 Del. C. §3801 et seq. Secured by trust assets; UCC-1 perfected.',
  'indemnity':        'This Indemnity Agreement is governed by Delaware law. The indemnifying party agrees to hold harmless all named beneficiaries against claims arising from the described obligations. UCC-9 security interest attached.',
  'reserve-pledge':   'This Reserve Pledge secures CIPR reserve obligations. The pledgor commits specified assets as collateral for CIPR issuance. Perfected under UCC Article 9; priority interest registered with Delaware SOS.',
  'court-order':      'Instrument issued pursuant to judicial authority. All parties are bound by the terms of this Order under applicable Delaware and federal law. Filed for record with the CipherNex ledger pursuant to trust governance protocols.',
  'trust-instrument': 'This Trust Instrument establishes, amends, or restates fiduciary arrangements under the laws of the State of Delaware. Governs the rights and obligations of all named parties to the trust. UCC-1 filed.',
};
const CIPHERNEX_PUBLIC_API = process.env.CIPHERNEX_PUBLIC_API || "http://127.0.0.1:3001";
const ANCHOR_WALLET_FILE = process.env.ANCHOR_WALLET_FILE || path.join(__dirname, "anchor-wallet.json");

// Best-effort on-chain anchor: zero-value DocumentAnchor transaction with the
// record's sha256 in the memo, then mine. Returns {blockHash, status}.
// The chain expects an elliptic secp256k1 KeyPair whose "address" is the full
// uncompressed public key hex — NOT an ethereum-style address.
async function anchorDocument(documentId, sha256, documentType, title) {
  try {
    const EC = require("/opt/ciphernex/node_modules/elliptic").ec;
    const ec = new EC("secp256k1");
    let wallet = null;
    try { wallet = JSON.parse(fs.readFileSync(ANCHOR_WALLET_FILE, "utf8")); } catch (e) {}
    let key = null;
    if (wallet && wallet.privateKey) {
      key = ec.keyFromPrivate(wallet.privateKey);
    } else {
      key = ec.genKeyPair();
      wallet = { address: key.getPublic("hex"), privateKey: key.getPrivate("hex") };
      fs.writeFileSync(ANCHOR_WALLET_FILE, JSON.stringify(wallet), { mode: 0o600 });
    }
    const from = key.getPublic("hex");
    const Transaction = require("/opt/ciphernex/src/blockchain/Transaction");
    const tx = new Transaction(from, from, 0,
      `DOC-ANCHOR ${documentId} | ${sha256} | ${documentType} | ${title}`,
      { transactionType: "DocumentAnchor" });
    tx.signTransaction(key);
    const sub = await fetch(`${CIPHERNEX_PUBLIC_API}/api/transactions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromAddress: tx.fromAddress, toAddress: tx.toAddress, amount: tx.amount, memo: tx.memo, signature: tx.signature, timestamp: tx.timestamp, transactionType: tx.transactionType }),
    });
    if (!sub.ok) {
      const j = await sub.json().catch(() => ({}));
      return { status: "queued", detail: j.error || "submit failed" };
    }
    const mined = await fetch(`${CIPHERNEX_PUBLIC_API}/api/mine`, { method: "POST" });
    const m = await mined.json().catch(() => ({}));
    const blockHash = (m.block && m.block.hash) || m.hash || m.blockHash;
    return blockHash ? { status: "anchored", blockHash } : { status: "queued", detail: "mined without hash" };
  } catch (e) {
    return { status: "queued", detail: e.message };
  }
}

// Resolve the 1:1 peg against the chain API balance endpoints.
async function verifyPeg(peg, amount) {
  const asset = String(peg.asset || "CIPR").toUpperCase();
  const addr = String(peg.address || "");
  if (!addr) return { status: "UNPEGGED", ratio: null, note: "no address" };
  try {
    const path = asset === "CIPR" ? `/api/cipr/balance/${addr}` : `/api/wallet/balance/${addr}`;
    const r = await fetch(`${CIPHERNEX_PUBLIC_API}${path}`);
    const j = await r.json().catch(() => ({}));
    const bal = parseFloat(j.balance ?? j.amount ?? j.value ?? j);
    const target = parseFloat(amount) || 0;
    const ratio = target > 0 ? (bal / target) : null;
    if (Number.isNaN(bal)) return { status: "UNPEGGED", ratio: null, note: "balance unavailable" };
    return { status: ratio !== null && ratio >= 1 ? "PEGGED" : "PEG_DRIFT", ratio, balance: bal };
  } catch (e) {
    return { status: "UNPEGGED", ratio: null, note: e.message };
  }
}

app.post("/api/public/instruments", publicLimiter, async (req, res) => {
  try {
    const { documentType, title, amount, currency = "CIPR", parties = {}, dueDate, memo, entity = {}, peg } = req.body || {};
    const legalAnchor = ANCHOR_TEMPLATES[documentType] || "12 USC 411 | UCC 3-311 | UCC 3-603";
    // ── validation ────────────────────────────────────────────────
    if (!DOC_TYPES.includes(documentType)) return res.status(400).json({ error: "Invalid documentType", validTypes: DOC_TYPES });
    const t = String(title || "").trim();
    if (!t || t.length > 300) return res.status(400).json({ error: "title is required (max 300 chars)" });
    if (!/^\d+(\.\d{1,8})?$/.test(String(amount))) return res.status(400).json({ error: "amount must be a positive number (max 8 decimals)" });
    const cur = String(currency).toUpperCase();
    if (!["CIPR", "USD", "XRP"].includes(cur)) return res.status(400).json({ error: "currency must be CIPR, USD, or XRP" });
    const ename = String(entity.name || "").trim().slice(0, 200);
    const eemail = String(entity.email || "").trim().toLowerCase().slice(0, 200);
    if (!ename || !eemail) return res.status(400).json({ error: "entity.name and entity.email are required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(eemail)) return res.status(400).json({ error: "entity.email format invalid" });
    const wallet = String(entity.wallet || "").trim();
    if (wallet && !/^(r[1-9A-HJ-NP-Za-km-z]{24,34}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(wallet)) {
      return res.status(400).json({ error: "entity.wallet format invalid (XRP r-address or BTC address)" });
    }
    // ── deterministic record hash (idempotency + tamper evidence) ──
    const record = {
      documentType, title: t, amount: String(amount), currency: cur,
      parties: { drawer: String(parties.drawer || "").trim(), drawee: String(parties.drawee || "").trim(), payee: String(parties.payee || "").trim() },
      dueDate: dueDate || null, memo: String(memo || "").slice(0, 2000), legalAnchor, entityName: ename,
    };
    const sha256 = crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
    const dup = db.prepare("SELECT * FROM documents WHERE sha256 = ? AND status = 'active'").get(sha256);
    if (dup) return res.status(200).json({ ok: true, id: dup.id, documentId: dup.document_id, sha256, duplicate: true, status: "active", note: "Instrument already registered." });
    const retired = db.prepare("SELECT * FROM documents WHERE sha256 = ? AND status = 'retired'").get(sha256);
    if (retired) return res.status(409).json({ error: "Instrument previously discharged — re-registration blocked" });
    // ── mint via service account ───────────────────────────────────
    const svcToken = await getServiceToken();
    if (!svcToken) return res.status(503).json({ error: "filing service not configured — contact administrator" });
    const mintBody = {
      documentType, title: t, amount: String(amount), currency: cur,
      parties: { drawer: record.parties.drawer || ename, drawee: record.parties.drawee, payee: record.parties.payee },
      dueDate: dueDate || undefined, memo: String(memo || "").slice(0, 2000), sha256, legalAnchor,
    };
    const mr = await fetch(`${CIPHERNEX_DOCS_API}/documents`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + svcToken },
      body: JSON.stringify(mintBody),
    });
    const chain = await mr.json().catch(() => ({}));
    if (!mr.ok) return res.status(502).json({ error: "ledger mint failed", detail: chain });
    const documentId = chain.documentId;
    // ── anchor on-chain (best-effort) ──────────────────────────────
    const anchor = await anchorDocument(documentId, sha256, documentType, t);
    // ── 1:1 peg (optional) ─────────────────────────────────────────
    let pegStatus = null;
    if (peg && (peg.address || peg.ref)) {
      const v = await verifyPeg(peg, amount);
      pegStatus = { asset: String(peg.asset || "CIPR").toUpperCase(), source: peg.source || "chain", address: peg.address || "", ref: peg.ref || "", ...v, verifiedAt: new Date().toISOString() };
    }
    // ── persist local row (PII encrypted) ──────────────────────────
    const id = uuidv4();
    db.prepare(`INSERT INTO documents
      (id, document_id, stored_name, filename, visibility, entity, uploaded_by,
       title, document_type, mime, size, sha256, status, amount, currency, parties, memo, chain_receipt,
       peg_type, peg_ref, peg_status, peg_ratio, peg_verified_at, anchor_block, anchor_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, documentId, "", t, "private", ename, "service:massey-public-mint",
      t, documentType, "application/json", Buffer.byteLength(JSON.stringify(record)), sha256, "active",
      String(amount), cur, JSON.stringify(record.parties), String(memo || "").slice(0, 2000), JSON.stringify(chain),
      pegStatus ? pegStatus.asset : null, pegStatus ? (pegStatus.address || pegStatus.ref) : null,
      pegStatus ? pegStatus.status : null, pegStatus ? String(pegStatus.ratio ?? "") : null,
      pegStatus ? pegStatus.verifiedAt : null, anchor.blockHash || null, anchor.status
    );
    logAudit("document.mint", documentId, `public filing ${documentType} ${t} anchor=${anchor.status}`, "public");
    mailer.send(eemail, `Your Massey & Rosupo Document ID: ${documentId}`,
      `Dear ${ename},\n\nYour instrument has been registered on the CipherNex ledger.\n\n  Document ID: ${documentId}\n  Type: ${documentType}\n  Title: ${t}\n  Amount: ${amount} ${cur}\n  On-chain anchor: ${anchor.blockHash || "queued"}\n  Value peg: ${pegStatus ? pegStatus.status : "not requested"}\n\nPresent this Document ID to your Trustee to initiate CIPR issuance.\n\n— Massey & Rosupo Co.`);
    return res.status(201).json({
      ok: true, id, documentId, sha256, status: "active", title: t, documentType,
      visibility: "private", entity: ename, anchor, peg: pegStatus,
      note: "Present this Document ID to your Trustee to initiate CIPR issuance.",
    });
  } catch (e) {
    return res.status(500).json({ error: "filing failed", detail: e.message });
  }
});

// ── Peg verification for an existing document (trustee-triggered sync) ───────
app.post("/api/documents/:id/peg/verify", requireRole(KC_REQUIRED_ROLE_TRUSTEE), async (req, res) => {
  const row = db.prepare("SELECT * FROM documents WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const peg = { asset: row.peg_type || "CIPR", address: row.peg_ref || "", ref: row.peg_ref || "" };
  const v = await verifyPeg(peg, row.amount || "0");
  const st = { ...v, verifiedAt: new Date().toISOString() };
  db.prepare("UPDATE documents SET peg_status=?, peg_ratio=?, peg_verified_at=? WHERE id=?").run(
    st.status, String(st.ratio ?? ""), st.verifiedAt, req.params.id);
  // Sync the peg status into the DocumentService record so the node's CIPR
  // issuance path (AdminGateway) can enforce the 1:1 gate.
  try {
    const svcToken = await getServiceToken();
    if (svcToken && row.document_id) {
      await fetch(`${CIPHERNEX_DOCS_API}/documents/${row.document_id}/peg`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer " + svcToken },
        body: JSON.stringify({ status: st.status, ratio: st.ratio ?? null }),
      });
    }
  } catch (e) { /* non-fatal */ }
  logAudit("document.peg", row.document_id, `${st.status} ratio=${st.ratio ?? "-"}`, req.user?.sub || "");
  if (st.status === "PEG_DRIFT") mailer.send(mailer.TRUSTEES.join(","), `[M&R] Peg drift on ${row.document_id}`, `Document ${row.document_id} (${row.title}) peg ratio is ${st.ratio} — below 1:1. Review the reserve position.`);
  res.json({ ok: true, id: req.params.id, documentId: row.document_id, peg: st });
});

// ── Secure file drop (temporary transfer channel; remove after files land) ──
const uploadRouter = require("./upload");
app.use("/api/upload", auditLimiter);
app.use("/api/upload", uploadRouter);
app.get("/uploaddrop", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "uploaddrop.html"));
});

// ── Static site (serve the M&R site files; API routes above take precedence) ──
// This makes index.html, portal-login.html, dashboards, arbitration section, etc.
// reachable directly from this backend. Placed AFTER all /api routes so it never
// shadows them.
const SITE_DIR = path.join(__dirname, "..");
app.use(express.static(SITE_DIR, { extensions: ["html"] }));
// SPA-style fallback for bare "/" -> index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(SITE_DIR, "index.html"));
});

// Only auto-listen when run directly (`node server.js`). When required as a
// module (tests, supertest, future tooling) the caller controls the server.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Massey & Rosupo backend listening on :${PORT}`);
  });
}

module.exports = app;
