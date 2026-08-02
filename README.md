# masseyrosupo.com — Frontend

Static frontend for **Massey & Rosupo Co.**, live at [masseyrosupo.com](https://masseyrosupo.com) via GitHub Pages.
Administrative corporate body of the **CipherNex** trust infrastructure.

---

## Pages

| File | URL | Auth | Description |
|---|---|---|---|
| `index.html` | `/` | Public | Corporate site — overview, structure, governance, operations, arbitration, contact |
| `my-account.html` | `/my-account.html` | Keycloak (either portal) | Account hub — PKCE exchange, role router |
| `portal-login.html` | `/portal-login.html` | Keycloak `massey-client` | Client/beneficiary portal login |
| `admin-portal.html` | `/admin-portal.html` | Keycloak `massey-admin` | Trustee login — full CIPR lifecycle |
| `logout.html` | `/logout.html` | — | Keycloak global session termination |
| `arbitration.html` | `/arbitration.html` | Trustee | Arbitration case manager (filing, tracking, awards) |
| `client-arbitration.html` | `/client-arbitration.html` | Beneficiary | Read-only "my cases" |
| `EntDash.html` | `/EntDash.html` | Trustee | Entity operations |
| `SecureMainDash.html` | `/SecureMainDash.html` | Trustee | Ledger & reserve operations (CIPR, filings, forms library) |
| `MainAccessDash.html` | `/MainAccessDash.html` | Trustee | Document & filing operations (Document ID, discharge) |
| `LitDash.html` | `/LitDash.html` | Trustee | Litigation & compliance ops (UCC §3/§9, arbitration) |
| `ledger.html` | `/ledger.html` | Trustee | Accrual ledger / instrument reference |
| `orders-results.html` | `/orders-results.html` | Trustee | Orders & results |
| `transactional-services.html` | `/transactional-services.html` | Trustee | Business license services |
| `uploaddrop.html` | `/uploaddrop.html` | Shared key | Internal file transfer (key-gated) |
| `manifold-tracker.html` | `/manifold-tracker.html` | Public | Manifold registry viewer |

Auth note: all portal auth is **Keycloak OIDC (realm `ciphernex`)** — public clients `massey-admin` (role `trustee`) and `massey-client` (role `beneficiary`) with PKCE. No Firebase.

---

## Backend

| Service | Host | Notes |
|---|---|---|
| M&R backend (site + API + document bridge) | `massey-api.wisdomignited.com` → nginx → `:3019` | systemd unit `masseyrosupo-backend.service`; SQLite (WAL) + doc-store |
| DocumentService | `:3004` (docker `ciphernex-docs-1`) | Trustee-gated mint/retire; on-chain Document IDs; rate-limited |
| AdminGateway | `admin.wisdomignited.com` → `:3005` | CipherNex admin console |
| PublicAPI | `:3001` (docker `ciphernex-ciphernex-api-1`) | General CipherNex API |
| Keycloak | `ciphernexid.wisdomignited.com` → `keycloak-ciphernex:8080` | Realm `ciphernex`, shared hub |
| M&R API base | `https://massey-api.wisdomignited.com/api` | Injected into `js/config.js` by CI |

---

## Deployment

- Hosted on **GitHub Pages** (CNAME `masseyrosupo.com`); repo `Wiz-DevTech/MasseyRosupo`.
- The GitHub Actions deploy workflow injects `CIPHERNEX_API_HOST` (Actions secret) into `js/config.js`:
  `CIPHERNEX_API_HOST = https://massey-api.wisdomignited.com/api`
- Note: the custom deploy workflow has been blocked by a GitHub account billing lock; the built-in
  `pages build and deployment` pipeline still publishes pushes. Resolve the billing lock to restore the
  custom workflow's secret injection.
- Local dev: the API base falls back to `location.origin + "/api"` when the origin contains
  `localhost` / `127.0.0.1` / `95.217.151.38`.
- Cache-busting: `bump_version.py` injects a single CACHE-BUST block per page (idempotent since 2026-08-02).

---

## Security model (as of 2026-08-02 remediation)

- All writes on the M&R backend are Keycloak-JWT gated (`trustee`/`beneficiary` realm roles), rate-limited,
  and audit-logged (`audit_log` table; `/api/audit` trustee read).
- Public write paths: `/api/contact` (validated, persisted, PII encrypted at rest, rate-limited,
  auto-ack email via local postfix when `MAIL_ENABLED=true`); `/api/upload` (shared-key, fail-closed,
  dest whitelist, no default key).
- Document ID minting is idempotent (SHA-256 dedup), unique-indexed, and blocked for discharged
  instruments. Amount/currency/wallet fields are server-side validated.
- At-rest PII encryption: AES-256-GCM (`ENCRYPTION_KEY` in backend `.env`, 64 hex chars).

---

## WisdomIgnited integration

`wisdomignited.com` hosts the member company directory and entity statuses. The M&R backend proxies
operations with a 60s TTL read-through cache (`/api/operations`, `sync: cache-ttl-60s`). Member links
surface via `ledger.html` / `manifold-tracker.html`; `window.CIPHERNEX_MEMBER_API` in `js/config.js`.

---

## API surface (M&R backend)

`/health` · `/api/auth/oidc-callback` (PKCE exchange, pinned redirect) · `/api/operations` (trustee) ·
`/api/arbitration` (trustee write; beneficiary sees own) · `/api/forms` (public read) ·
`/api/schedule-fees` (public read, trustee write) · `/api/filings` (trustee) ·
`/api/documents` (trustee upload/mint; client own+public read; download ACL; retire/reject) ·
`/api/audit` (trustee) · `/api/contact` (public) · `/api/upload` (key-gated)
