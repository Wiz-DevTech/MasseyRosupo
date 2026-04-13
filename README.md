# masseyrosupo.com — Frontend

Static frontend for **Massey & Rosupo Co.**, live at [masseyrosupo.com](https://masseyrosupo.com) via GitHub Pages.  
Administrative corporate body of the **CipherNex** trust infrastructure.

---

## Pages

| File | URL | Auth | Description |
|---|---|---|---|
| `index.html` | `/` | Public | Corporate site — overview, structure, governance, contact |
| `portal-login.html` | `/portal-login` | None | Client portal login (Firebase Auth) |
| `MainAccessDash.html` | `/MainAccessDash` | Firebase | Client dashboard |
| `SecureMainDash.html` | `/SecureMainDash` | Firebase | Secure client variant |
| `EntDash.html` | `/EntDash` | Firebase | Enterprise dashboard |
| `LitDash.html` | `/LitDash` | Firebase | Litigation/legal dashboard |
| `admin-portal.html` | `/admin-portal` | HMAC + JWT | Trustee admin console — full CIPR lifecycle |

---

## Backend (CipherNex Node — Hetzner `37.27.214.143`)

| Service | Port | Cloudflare subdomain |
|---|---|---|
| Public API | 3001 | `api.wisdomignited.com` (pending DNS) |
| AuthService | 3003 | `api.wisdomignited.com` (pending DNS) |
| DocumentService | 3004 | `api.wisdomignited.com` (pending DNS) |
| AdminGateway | 3005 | `admin.wisdomignited.com` (pending DNS) |
| JSON-RPC | 8545 | Direct IP — MetaMask only |

---

## Deployment Config

Edit **`js/config.js`** to switch environments (local dev only — CI injects production values).

The GitHub Actions deploy workflow reads two secrets:
- `CIPHERNEX_API_HOST` — base host (e.g. `http://37.27.214.143`)
- `CIPHERNEX_CONFIG_JSON` — optional per-service overrides once subdomains are live:
  ```json
  {"auth":"https://api.wisdomignited.com","admin":"https://admin.wisdomignited.com","docs":"https://api.wisdomignited.com","pub":"https://api.wisdomignited.com"}
  ```

---

## wisdomignited.com Integration (upcoming)

`wisdomignited.com` hosts the member company directory and current status of each entity in the trust structure.  
The integration hook is in `js/config.js` as `window.CIPHERNEX_MEMBER_API`.

---

## Auth

| Portal | Mechanism |
|---|---|
| Client portal | Firebase Email/Password (project: `masseyrosupo`) |
| Trustee admin | HMAC-SHA256 challenge-response → JWT (CipherNex AuthService :3003) |
