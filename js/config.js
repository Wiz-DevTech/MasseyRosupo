/**
 * CipherNex Frontend Configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * Controls which backend server the admin portal and registration forms call.
 *
 * PRODUCTION (current):
 *   API routes through admin.wisdomignited.com (Cloudflare → Hetzner :3005)
 *   Auth routes through api.wisdomignited.com  (Cloudflare → Hetzner :3003)
 *
 * LOCAL DEV:
 *   Set window.CIPHERNEX_API_HOST = 'http://localhost' — or just leave as-is,
 *   the localhost fallback in admin-portal.html handles it automatically.
 *
 * WISDOMIGNITED.COM INTEGRATION (upcoming):
 *   wisdomignited.com serves member company listings and their current statuses.
 *   When that integration is wired, add the member API endpoint here:
 *     window.CIPHERNEX_MEMBER_API = 'https://wisdomignited.com/api';
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * To change for a different environment, edit the line below only.
 * The GitHub Actions deploy workflow injects CIPHERNEX_API_HOST automatically
 * from the repository secret — this file value is used for local dev only.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── API host — edit this one line to switch environments ──────────────────────
window.CIPHERNEX_API_HOST = 'http://localhost'; // overridden at deploy time by CI

// ── Individual endpoint overrides (optional) ─────────────────────────────────
// Leave as null to derive all endpoints from CIPHERNEX_API_HOST above.
// Set individual overrides here if services live on different subdomains:
//
//   window.CIPHERNEX_CONFIG = {
//     auth:  'https://api.wisdomignited.com',     // :3003 via Cloudflare
//     admin: 'https://admin.wisdomignited.com',   // :3005 via Cloudflare
//     docs:  'https://api.wisdomignited.com',     // :3004 via Cloudflare
//     pub:   'https://api.wisdomignited.com',     // :3001 via Cloudflare
//   };
window.CIPHERNEX_CONFIG = null;

// ── Member company API (wisdomignited.com integration — coming soon) ──────────
window.CIPHERNEX_MEMBER_API = null; // will be 'https://wisdomignited.com/api'
