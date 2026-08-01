/* M&R shared nav loader — injects partials/site-nav.html at top of <body>
   and hides each page's original nav so the themed console nav is seamless
   across all pages. One source of truth: partials/site-nav.html. */
(function () {
  function hideOldNav() {
    // Selectors of the pre-existing per-page navs to suppress.
    var sels = [
      '.top-nav', '.main-nav',        // EntDash / SecureMainDash
      '.navbar', '.topbar',           // LitDash
      'body > header', 'header.header',// MainAccessDash standalone header
      'body > nav:not(.mr-main-nav):not(.mr-top-nav)'
    ];
    sels.forEach(function (s) {
      document.querySelectorAll(s).forEach(function (el) {
        if (el.closest('.mr-top-nav') || el.closest('.mr-main-nav')) return;
        el.style.display = 'none';
      });
    });
  }
  function inject(html) {
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    // Move <link>/<style> into <head>, nav elements to top of body.
    var head = document.head;
    var frag = document.createDocumentFragment();
    Array.prototype.slice.call(wrap.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && (n.tagName === 'LINK' || n.tagName === 'STYLE')) head.appendChild(n);
      else frag.appendChild(n);
    });
    hideOldNav();
    document.body.insertBefore(frag, document.body.firstChild);
    // highlight active tab by filename
    var page = location.pathname.split('/').pop().toLowerCase();
    var map = { 'entdash.html':'entity','litdash.html':'matters','securemaindash.html':'forms','orders-results.html':'orders','transactional-services.html':'txn','arbitration.html':'arbitration','my-account.html':'account' };
    var key = map[page];
    if (key) {
      var t = document.querySelector('.mr-nav-tab[data-nav="' + key + '"]');
      if (t) t.classList.add('active');
    }
  }
  fetch('partials/site-nav.html', { cache: 'no-cache' })
    .then(function (r) { return r.text(); })
    .then(inject)
    .catch(function (e) { console.error('nav load failed', e); });
})();
