#!/usr/bin/env node
// End-to-end signing smoke test — Stellar testnet.
//
// Exercises the full signSacTransfer path that ships to users:
//   1. generate a fresh keypair
//   2. fund it via Friendbot
//   3. call signSacTransfer against testnet USDC SAC
//   4. decode the returned XDR and assert it parses as a valid
//      InvokeHostFunction envelope with signed auth entries
//
// This is the regression gate. It catches all three bugs that shipped
// in v1.1.0 – v1.1.2:
//   - v1.1.0: WWW-Authenticate regex (checked separately in a unit test
//             — this test covers the signing path specifically)
//   - v1.1.1: ALL_ZEROS_PUBKEY 53 chars → StrKey.isValidEd25519PublicKey
//             assertion at module load throws before this test can run
//   - v1.1.2: opXdr.body() missing on high-level Operation → test fails
//             with a clear TypeError
//
// Do NOT ship a new version without this test passing.
//
// Usage:
//   node scripts/smoke-test-sign.mjs
//
// Exit code: 0 on success, non-zero on any failure.

import { Keypair, xdr } from "@stellar/stellar-sdk";
import { signSacTransfer } from "./src/stellar-signer.js";

// Native XLM SAC on testnet — derived from Asset.native().contractId(Networks.TESTNET).
//
// We use native XLM instead of USDC because:
//   1. Every Friendbot-funded account natively holds XLM, so no trustline
//      is required (Circle's testnet USDC SAC errors with "trustline entry
//      is missing" when transferred from a fresh account).
//   2. The signing code path is asset-agnostic — SAC transfer simulation,
//      authorizeEntry, and assembleTransaction are the same for any SAC.
//   3. Tests are hermetic: no external dependency on Circle's testnet
//      faucet or trustline state.
const TESTNET_NATIVE_XLM_SAC =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// Friendbot endpoint (funds a testnet account with 10_000 XLM).
const FRIENDBOT = "https://friendbot.stellar.org";

function log(msg: string) {
  console.log(`[smoke] ${msg}`);
}

function fail(msg: string, err?: unknown): never {
  console.error(`[smoke] FAIL: ${msg}`);
  if (err) console.error(err);
  process.exit(1);
}

/**
 * Friendbot has a history of TLS resets and 5xxs under load. Retry
 * transient network failures with exponential backoff before giving up.
 */
async function friendbotFund(address: string, label: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT}?addr=${address}`);
      if (res.ok) return;
      const body = await res.text();
      // 400 with "createAccountAlreadyExist" means already funded — treat as success.
      if (body.includes("createAccountAlreadyExist") || body.includes("already funded")) {
        return;
      }
      throw new Error(`Friendbot ${label} returned ${res.status}: ${body}`);
    } catch (e: any) {
      if (attempt === maxAttempts) {
        fail(`Friendbot ${label} failed after ${maxAttempts} attempts`, e);
      }
      const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s
      log(`  Friendbot ${label} attempt ${attempt} failed (${e.message ?? e}); retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  log("Generating throwaway keypair...");
  const kp = Keypair.random();
  const secret = kp.secret();
  const pubkey = kp.publicKey();
  log(`  pubkey: ${pubkey}`);

  log("Funding sender via Friendbot...");
  await friendbotFund(pubkey, "sender");
  log("  sender funded.");

  // Recipient: a second throwaway keypair. Native XLM SAC simulation
  // requires the recipient account to exist on-chain (error Contract#6
  // = AccountEntryMissing), so we fund it via Friendbot too.
  const recipientKp = Keypair.random();
  const payTo = recipientKp.publicKey();
  log(`  payTo: ${payTo}`);
  log("Funding recipient via Friendbot...");
  await friendbotFund(payTo, "recipient");
  log("  recipient funded.");

  log("Calling signSacTransfer...");
  let signed;
  try {
    signed = await signSacTransfer(
      {
        secret,
        network: "testnet",
        rpcUrl: "https://soroban-testnet.stellar.org",
      },
      {
        assetSac: TESTNET_NATIVE_XLM_SAC,
        payTo,
        amountBaseUnits: "1", // 1 stroop = 0.0000001 XLM, smallest nonzero
        maxTimeoutSeconds: 60,
      },
    );
  } catch (e) {
    fail("signSacTransfer threw", e);
  }

  log("Signed payment returned:");
  log(`  signerPubkey:       ${signed.signerPubkey}`);
  log(`  validUntilLedger:   ${signed.validUntilLedger}`);
  log(`  transactionXdr len: ${signed.transactionXdr.length}`);

  // Assertions:
  if (signed.signerPubkey !== pubkey) {
    fail(
      `signerPubkey mismatch: got ${signed.signerPubkey}, want ${pubkey}`,
    );
  }
  if (!signed.transactionXdr || signed.transactionXdr.length < 50) {
    fail(`transactionXdr looks truncated: ${signed.transactionXdr}`);
  }
  if (typeof signed.validUntilLedger !== "number" || signed.validUntilLedger <= 0) {
    fail(`validUntilLedger invalid: ${signed.validUntilLedger}`);
  }

  log("Decoding returned XDR envelope...");
  let envelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(signed.transactionXdr, "base64");
  } catch (e) {
    fail("returned XDR is not a valid TransactionEnvelope", e);
  }

  const envType = envelope.switch().name;
  if (envType !== "envelopeTypeTx") {
    fail(`unexpected envelope type: ${envType}, want envelopeTypeTx`);
  }

  const ops = envelope.v1().tx().operations();
  if (ops.length !== 1) {
    fail(`expected exactly 1 op, got ${ops.length}`);
  }

  const op = ops[0];
  const opType = op.body().switch().name;
  if (opType !== "invokeHostFunction") {
    fail(`expected invokeHostFunction, got ${opType}`);
  }

  const hostFnOp = op.body().invokeHostFunctionOp();
  const authEntries = hostFnOp.auth();
  if (authEntries.length === 0) {
    fail(
      "host function op has zero auth entries — signing did not patch them in. " +
        "This is the v1.1.2 regression: preparedTx.operations[0].body() was undefined " +
        "and the manual auth patch silently did nothing.",
    );
  }
  log(`  auth entries: ${authEntries.length}`);

  // Also verify the source account on the envelope is our pubkey, not the
  // all-zeros placeholder. assembleTransaction should rebuild with a real
  // source during simulation.
  // Actually — our signing flow uses the placeholder source intentionally
  // (the facilitator/server rebuilds the envelope with its own source
  // before submission). So we expect the ALL_ZEROS placeholder here, not
  // our pubkey. Assert that for clarity.
  const sourceAccountEd25519 = envelope
    .v1()
    .tx()
    .sourceAccount()
    .ed25519();
  const allZeros = Buffer.alloc(32);
  if (!sourceAccountEd25519.equals(allZeros)) {
    fail(
      `expected placeholder (all-zeros) source account, got non-zero — ` +
        `sponsored flow requires ALL_ZEROS placeholder so the facilitator ` +
        `can rebuild with its own source.`,
    );
  }
  log("  source account: all-zeros placeholder (correct for sponsored flow)");

  log("");
  log("✅ PASS — signing path end-to-end verified on testnet.");
  process.exit(0);
}

main().catch((e) => fail("unexpected error", e));
