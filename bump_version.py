#!/usr/bin/env python3
"""Bump the deploy version across all static pages so browsers/Cloudflare
can never serve a stale cached snapshot. Idempotent: safe to re-run.

Writes version.txt (the source of truth) and injects into every *.html:
  <meta name="x-page-version" content="HASH">
  <script src="partials/cache-bust.js?v=HASH"></script>
Run after `git push` so HASH == the deployed commit.
"""
import os, re, subprocess, sys

ROOT = "/opt/masseyrosupo.com"

def git_short():
    try:
        return subprocess.check_output(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"]).decode().strip()
    except Exception:
        return "dev"

HASH = sys.argv[1] if len(sys.argv) > 1 else git_short()
print("Deploy version:", HASH)

# 1) version.txt (no trailing newline issues)
with open(os.path.join(ROOT, "version.txt"), "w") as f:
    f.write(HASH + "\n")

META = f'  <meta name="x-page-version" content="{HASH}">'
SCRIPT = f'  <script src="partials/cache-bust.js?v={HASH}"></script>'
BLOCK = "<!-- CACHE-BUST start -->\n" + META + "\n" + SCRIPT + "\n  <!-- CACHE-BUST end -->"

# Also version every partials/*.js include so browsers fetch the fresh script
# (otherwise a cached old keycloak-gate.js/site-nav.js keeps stale behaviour).
PARTIAL_RE = re.compile(r'(<script src="partials/[^"]+\.js)(?:\?v=[0-9a-f]+)?("></script>)')

# Remove any existing CACHE-BUST block (idempotent)
re_block = re.compile(r"  <!-- CACHE-BUST start -->.*?<!-- CACHE-BUST end -->\n", re.S)

count = 0
for fn in sorted(os.listdir(ROOT)):
    if not fn.endswith(".html"):
        continue
    p = os.path.join(ROOT, fn)
    s = open(p, encoding="utf-8").read()
    s2 = re_block.sub("", s)
    # Version all partials/*.js includes (strip old ?v, add new) so stale cached
    # gate/nav scripts can never keep old behaviour.
    s2 = PARTIAL_RE.sub(rf'\1?v={HASH}\2', s2)
    if s2 != s:
        pass  # stripped old / versioned partials
    # Inject right after <head> (or after <meta charset> if no <head> tag, fallback to top)
    if "<head>" in s2:
        s2 = s2.replace("<head>", "<head>\n" + BLOCK, 1)
    elif "<meta charset" in s2:
        s2 = re.sub(r'(<meta charset[^>]*>)', r'\1\n' + BLOCK, s2, count=1)
    else:
        s2 = BLOCK + "\n" + s2
    open(p, "w", encoding="utf-8").write(s2)
    count += 1

print(f"Injected cache-bust (v={HASH}) into {count} HTML files.")
