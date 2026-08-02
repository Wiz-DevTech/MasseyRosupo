// Test stubs for the three external services the M&R backend talks to:
//   docs  = DocumentService (:3004)      — mint/retire/peg
//   kc    = Keycloak (:8123)             — client-credentials token
//   chain = CipherNex public API (:3001) — wallet/create, transactions, mine, balances
// All hermetic: nothing touches the real node or the real ledger.
const http = require("http");

async function startStubs() {
  let docCounter = 0;

  const docs = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/documents") {
      docCounter++;
      const documentId = `DOC-TEST-${String(docCounter).padStart(12, "0")}`;
      res.end(JSON.stringify({ status: "created", documentId, document: { documentId, status: "active" }, nextStep: {} }));
    } else if (req.method === "PATCH" && /\/documents\/[^/]+\/peg$/.test(req.url)) {
      res.end(JSON.stringify({ status: "updated", pegStatus: "ok" }));
    } else if (req.method === "PATCH" && req.url.includes("/retire")) {
      res.end(JSON.stringify({ status: "retired" }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "stub: not found" }));
    }
  });

  const kc = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.includes("/token")) {
      res.end(JSON.stringify({ access_token: "test-svc-token", token_type: "Bearer", expires_in: 300 }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });

  const chain = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/wallet/create") {
      // A REAL secp256k1 keypair so the anchor signing path is exercised.
      const EC = require("/opt/ciphernex/node_modules/elliptic").ec;
      const key = new EC("secp256k1").genKeyPair();
      res.end(JSON.stringify({ status: "success", wallet: { address: key.getPublic("hex"), privateKey: key.getPrivate("hex") } }));
    } else if (req.url === "/api/transactions") {
      res.end(JSON.stringify({ status: "success", transaction: { ok: true } }));
    } else if (req.url === "/api/mine") {
      res.end(JSON.stringify({ block: { hash: "0xTESTBLOCK" + Date.now().toString(16) }, transactions: [] }));
    } else if (req.url.startsWith("/api/cipr/balance/")) {
      const addr = req.url.split("/").pop();
      res.end(JSON.stringify({ balance: addr.startsWith("rich") ? 1000000 : 0 }));
    } else if (req.url.startsWith("/api/wallet/balance/")) {
      res.end(JSON.stringify({ balance: 0 }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });

  const listen = (s) => new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(s.address().port)));
  const [docsPort, kcPort, chainPort] = await Promise.all([listen(docs), listen(kc), listen(chain)]);

  return {
    docs, kc, chain,
    ports: { docs: docsPort, kc: kcPort, chain: chainPort },
    close: () => Promise.all([docs.close(), kc.close(), chain.close()]),
  };
}

module.exports = { startStubs };
