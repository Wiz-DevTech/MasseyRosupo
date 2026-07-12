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
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3009;

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

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-prod-masseyrosupo";
const WISDOM_BACKEND_API = process.env.WISDOM_BACKEND_API || "https://wisdomignited.com/api";

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
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Migration: ensure arbitration columns exist (idempotent) ──────────────────
// Older DBs were created with the thin schema; add the richer case columns
// without dropping existing data.
(function migrateArbitrations(){
  const cols = db.prepare("PRAGMA table_info(arbitrations)").all().map(c => c.name);
  const want = ["entity","address","agreement","commerce","violations","total","award_date","bar_date","owner_sub","owner_name"];
  for (const c of want) {
    if (!cols.includes(c)) db.prepare(`ALTER TABLE arbitrations ADD COLUMN ${c} TEXT`).run();
  }
})();

// ── Middleware ────────────────────────────────────────────────────────────────
// CSP disabled here: the site uses inline styles/scripts, Google Fonts, and a
// cross-origin Keycloak redirect. helmet's default CSP would break the look.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

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

// ── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, service: "masseyrosupo-backend" }));

// ── OIDC callback (ported from wisdom-backend) ───────────────────────────────
// Exchanges `code` + `code_verifier` for a Keycloak token, role-checks, returns
// the access token. `portal` selects which M&R client/role applies.
app.post("/api/auth/oidc-callback", async (req, res) => {
  const { code, code_verifier, redirect_uri, portal } = req.body;
  if (!code || !code_verifier) return res.status(400).json({ error: "missing code" });

  const isClient = portal === "client";
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
app.get("/api/operations", auth, async (req, res) => {
  const local = db.prepare("SELECT * FROM operations ORDER BY created_at DESC").all();
  try {
    const upstream = await fetch(`${WISDOM_BACKEND_API}/operations`, {
      headers: { Authorization: req.headers.authorization || "" },
    });
    const up = upstream.ok ? await upstream.json() : [];
    res.json({ local, upstream: up });
  } catch (e) {
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
      : db.prepare("SELECT * FROM arbitrations WHERE owner_sub = ? ORDER BY created_at DESC")
          .all(req.user?.sub || "");
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
    violations, total, status, clause, detail,
  } = req.body || {};
  if (!respondent) return res.status(400).json({ error: "respondent is required" });
  const owner_sub = req.user?.sub || "";
  const owner_name = req.user?.preferred_username || req.user?.email || owner_sub;
  db.prepare(`INSERT INTO arbitrations
    (id, case_ref, claimant, respondent, entity, address, agreement, commerce,
     violations, total, status, clause, detail, owner_sub, owner_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
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
    owner_name
  );
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
      drawer = "", drawee = "", payee = "",
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

    // 3. Persist the LOCAL record — only gateway-local fields. CipherNex is the
    //    source of truth for title/type/parties/amount/status/sha256.
    const id = uuidv4();
    db.prepare(`INSERT INTO documents
      (id, document_id, stored_name, filename, visibility, entity, uploaded_by)
      VALUES (?,?,?,?,?,?,?)`).run(
      id, documentId, path.basename(req.file.path), req.file.originalname,
      visibility === "public" ? "public" : "private", entity, req.user?.sub || "trustee"
    );

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
app.post("/api/contact", async (req, res) => {
  // Accept inbound verified inquiries from the public site.
  const { name, email, nature, message } = req.body || {};
  console.log("[contact] inquiry from", email, "re:", nature);
  res.json({ ok: true, received: true });
});

// ── Secure file drop (temporary transfer channel; remove after files land) ──
const uploadRouter = require("./upload");
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

app.listen(PORT, () => {
  console.log(`Massey & Rosupo backend listening on :${PORT}`);
});

module.exports = app;
