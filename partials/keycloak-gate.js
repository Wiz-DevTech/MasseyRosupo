/* Shared Keycloak trustee gate for M&R dashboards.
   Mirrors the access model of arbitration.html: only accounts with the
   `trustee` realm role (massey-admin) may open these fiduciary consoles.
   Beneficiaries / anonymous visitors see a forbidden / sign-in screen.

   The including page must contain two overlays:
     <div id="kc-gate" class="kc-gate"> ... <button id="kc-signin">Sign In</button> ... </div>
     <div id="kc-forbidden" class="kc-forbidden" style="display:none"> ... </div>
   and hide its own content until authed (the gate overlay is fixed full-screen
   so it covers the console until the user is authenticated). */

const KC_AUTH  = "https://ciphernexid.wisdomignited.com/realms/ciphernex/protocol/openid-connect/auth";
const KC_TOKEN = "https://ciphernexid.wisdomignited.com/realms/ciphernex/protocol/openid-connect/token";
const KC_REQUIRED_ROLE_TRUSTEE = "trustee";
const KC_CLIENT = "massey-admin";
const KC_REDIRECT = location.origin + location.pathname;

function _kcB64url(buf){ return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function _kcRnd(n){ return _kcB64url(crypto.getRandomValues(new Uint8Array(n))); }
function _kcDecode(t){ try { return JSON.parse(atob(t.split('.')[1])); } catch(e){ return null; } }
function _kcIsTrustee(){
  const t = localStorage.getItem('mrToken');
  if (!t) return false;
  try {
    const p = _kcDecode(t);
    const roles = (p.realm_access && p.realm_access.roles) || [];
    return roles.includes(KC_REQUIRED_ROLE_TRUSTEE);
  } catch(e){ return false; }
}

function _kcShowGate(){
  const g = document.getElementById('kc-gate');
  const f = document.getElementById('kc-forbidden');
  if (g) g.style.display = '';
  if (f) f.style.display = 'none';
}
function _kcShowForbidden(){
  const g = document.getElementById('kc-gate');
  const f = document.getElementById('kc-forbidden');
  if (g) g.style.display = 'none';
  if (f) f.style.display = '';
}
function _kcHideAll(){
  const g = document.getElementById('kc-gate');
  const f = document.getElementById('kc-forbidden');
  if (g) g.style.display = 'none';
  if (f) f.style.display = 'none';
}

function kcGoKeycloak(){
  const verifier = _kcRnd(32);
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(h => {
    const challenge = _kcB64url(h);
    const state = _kcRnd(16);
    sessionStorage.setItem('kc_pkce_v', verifier);
    location.href = KC_AUTH + "?" + new URLSearchParams({
      client_id: KC_CLIENT, response_type: "code", scope: "openid",
      redirect_uri: KC_REDIRECT, state, code_challenge: challenge, code_challenge_method: "S256"
    }).toString();
  });
}

/* Shared authenticated API helper for dashboards.
   Returns parsed JSON. Throws on non-2xx. Uses the stored mrToken. */
async function kcApi(path, opts = {}) {
  const token = localStorage.getItem('mrToken');
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(location.origin + "/api" + path, Object.assign({ headers }, opts));
  if (res.status === 401 || res.status === 403) {
    // Session expired or lost trustee role — send back to gate.
    _kcShowGate();
    throw new Error("unauthorized");
  }
  return res.json();
}
window.kcApi = kcApi;

/* True once a trustee session is active (use to gate data loads). */
function kcIsAuthed() { return _kcIsTrustee(); }
window.kcIsAuthed = kcIsAuthed;

(function _kcHandleCallback(){
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return;
  const verifier = sessionStorage.getItem('kc_pkce_v');
  if (!verifier) return;
  fetch(KC_TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: KC_CLIENT, code, redirect_uri: KC_REDIRECT, code_verifier: verifier }) })
    .then(r => r.json()).then(j => {
      if (j.access_token) {
        localStorage.setItem('mrToken', j.access_token);
        if (j.refresh_token) localStorage.setItem('mrRefresh', j.refresh_token);
        sessionStorage.removeItem('kc_pkce_v');
        history.replaceState(null, '', KC_REDIRECT);
        if (_kcIsTrustee()) { _kcHideAll(); window.dispatchEvent(new Event('kc:authed')); }
        else _kcShowForbidden();
      } else {
        _kcShowGate();
      }
    }).catch(() => _kcShowGate());
})();

(function _kcBoot(){
  if (_kcIsTrustee()) _kcHideAll();
  else if (localStorage.getItem('mrToken')) _kcShowForbidden();
  else _kcShowGate();
})();

document.addEventListener('DOMContentLoaded', function(){
  const btn = document.getElementById('kc-signin');
  if (btn) btn.addEventListener('click', kcGoKeycloak);
});
