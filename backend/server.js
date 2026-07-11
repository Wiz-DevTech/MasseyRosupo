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
    case_ref TEXT,
    claimant TEXT,
    respondent TEXT,
    status TEXT,            -- 'filed' | 'pending' | 'awarded' | 'closed'
    clause TEXT,            -- binding arbitration clause text
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// Verify a Keycloak access token (RS256, hub realm). Returns decoded payload.
async function verifyKeycloakToken(token) {
  try {
    const jwksRes = await fetch(`${KC_URL}/realms/${KC_REALM}`);
    const realm = await jwksRes.json();
    const key = realm.public_key;
    const decoded = jwt.verify(token, key, { algorithms: ["RS256"] });
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
// Binding arbitration is a core M&R governance instrument. Upstream holds the
// substantial case/arbitration APIs + wisdomignited links; this stores M&R cases.
app.get("/api/arbitration", auth, async (req, res) => {
  const local = db.prepare("SELECT * FROM arbitrations ORDER BY created_at DESC").all();
  try {
    const upstream = await fetch(`${WISDOM_BACKEND_API}/arbitration`, {
      headers: { Authorization: req.headers.authorization || "" },
    });
    const up = upstream.ok ? await upstream.json() : [];
    res.json({ local, upstream: up });
  } catch (e) {
    res.json({ local, upstream: [], note: "upstream unavailable" });
  }
});

app.post("/api/arbitration", requireRole(KC_REQUIRED_ROLE_TRUSTEE), (req, res) => {
  const id = uuidv4();
  const { case_ref, claimant, respondent, status, clause, detail } = req.body;
  db.prepare("INSERT INTO arbitrations (id, case_ref, claimant, respondent, status, clause, detail) VALUES (?,?,?,?,?,?,?)")
    .run(id, case_ref, claimant, respondent, status || "filed", clause || "", detail || "");
  res.json({ id, ok: true });
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

// ── Public site contact/document endpoint (replaces localhost:3005 dependency) ──
app.post("/api/contact", async (req, res) => {
  // Accept inbound verified inquiries from the public site.
  const { name, email, nature, message } = req.body || {};
  console.log("[contact] inquiry from", email, "re:", nature);
  res.json({ ok: true, received: true });
});

app.listen(PORT, () => {
  console.log(`Massey & Rosupo backend listening on :${PORT}`);
});

module.exports = app;
