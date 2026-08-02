// Unit test for the on-chain anchor signing math — the exact path that failed
// in production ("Cannot add invalid transaction to chain"). Runs against the
// REAL Transaction class + elliptic, no containers, no network.
// This reproduces the API's reconstruction: new Transaction + set timestamp +
// set signature, then isValid(). If this passes, the remaining production
// failure is environmental (stale container code), not the signing math.
const { test } = require("node:test");
const assert = require("node:assert");
const Transaction = require("/opt/ciphernex/src/blockchain/Transaction");
const EC = require("/opt/ciphernex/node_modules/elliptic").ec;

test("signed DocumentAnchor survives API-style reconstruction and verifies", () => {
  const ec = new EC("secp256k1");
  const key = ec.genKeyPair();
  const from = key.getPublic("hex");

  const tx = new Transaction(from, from, 0, "DOC-ANCHOR TEST | sha | type | title", { transactionType: "DocumentAnchor" });
  tx.signTransaction(key);
  assert.ok(tx.signature, "signature produced");
  assert.ok(tx.signature.length > 0, "signature non-empty");

  // Mimic APIServer POST /api/transactions reconstruction (fixed code path).
  const { fromAddress, toAddress, amount, memo, timestamp, transactionType } = tx;
  const rebuilt = new Transaction(fromAddress, toAddress, amount, memo, { transactionType });
  if (timestamp) rebuilt.timestamp = timestamp;
  rebuilt.signature = tx.signature;

  assert.strictEqual(rebuilt.calculateHash(), tx.calculateHash(), "hash must match after reconstruction");
  assert.strictEqual(rebuilt.isValid(), true, "reconstructed transaction must verify");
});

test("timestamp roll destroys validity (the original bug)", () => {
  const ec = new EC("secp256k1");
  const key = ec.genKeyPair();
  const from = key.getPublic("hex");
  const tx = new Transaction(from, from, 0, "memo", { transactionType: "DocumentAnchor" });
  tx.signTransaction(key);

  // Old buggy path: reconstruction WITHOUT preserving timestamp.
  const rebuilt = new Transaction(tx.fromAddress, tx.toAddress, tx.amount, tx.memo);
  rebuilt.signature = tx.signature;
  assert.notStrictEqual(rebuilt.calculateHash(), tx.calculateHash(), "fresh timestamp changes the hash");
});
