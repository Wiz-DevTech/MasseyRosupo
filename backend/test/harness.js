// Test harness: boot the real M&R app against stubs and a throwaway SQLite DB.
// Env is set BEFORE requiring server.js (it reads env at module load).
const os = require("os");
const path = require("path");
const fs = require("fs");
const { startStubs } = require("./stubs");

async function boot() {
  const stubs = await startStubs();
  const tmpDb = path.join(os.tmpdir(), `mr-test-${process.pid}.db`);
  const tmpWallet = path.join(os.tmpdir(), `mr-test-anchor-${process.pid}.json`);
  for (const f of [tmpDb, tmpDb + "-wal", tmpDb + "-shm", tmpWallet]) fs.rmSync(f, { force: true });

  process.env.MR_DB = tmpDb;
  process.env.PORT = "0";
  process.env.KC_URL = `http://127.0.0.1:${stubs.ports.kc}`;
  process.env.CIPHERNEX_DOCS_API = `http://127.0.0.1:${stubs.ports.docs}`;
  process.env.CIPHERNEX_PUBLIC_API = `http://127.0.0.1:${stubs.ports.chain}`;
  process.env.MAIL_ENABLED = "false";
  process.env.ENCRYPTION_KEY = "c".repeat(64);
  process.env.KC_SERVICE_CLIENT = "test-mint";
  process.env.KC_SERVICE_SECRET = "test-secret";
  process.env.UPLOAD_KEY = "test-upload-key";
  process.env.ANCHOR_WALLET_FILE = tmpWallet;
  process.env.CORS_ORIGINS = "https://masseyrosupo.com,http://127.0.0.1:3019";

  delete require.cache[require.resolve("../server.js")];
  const app = require("../server.js");
  const server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  return {
    base, server, stubs, dbPath: tmpDb,
    cleanup: async () => {
      server.closeAllConnections?.();
      server.close();
      await stubs.close();
      for (const f of [tmpDb, tmpDb + "-wal", tmpDb + "-shm", tmpWallet]) fs.rmSync(f, { force: true });
    },
  };
}

module.exports = { boot };
