/* Cache-buster: defeats browser + Cloudflare edge caching of stale HTML.
 * Each page carries <meta name="x-page-version" content="HASH"> and loads this
 * script with ?v=HASH. On load we fetch /version.txt with a Date.now() query
 * (never cached). If the deployed version differs from this page's baked
 * version, we reload ONCE (guarded by sessionStorage) to pull the fresh HTML.
 * Requires no Cloudflare API token. */
(function () {
  try {
    var meta = document.querySelector('meta[name="x-page-version"]');
    var PV = meta ? meta.getAttribute('content') : null;
    if (!PV) return;
    if (sessionStorage.getItem('mr_cachebust') === PV) return; // already refreshed for this version
    fetch('/version.txt?_=' + Date.now())
      .then(function (r) { return r.text(); })
      .then(function (t) {
        t = (t || '').trim();
        if (t && t !== PV) {
          sessionStorage.setItem('mr_cachebust', t);
          location.reload(true);
        }
      })
      .catch(function () {});
  } catch (e) {}
})();
