#!/usr/bin/env node
// End-to-end smoke test for send-raw — Stellar testnet.
//
// Exercises the exact path that ships to users:
//   1. generate two throwaway keypairs, fund both via Friendbot
//   2. call sendRaw() with an amount and a text memo
//   3. re-read the submitted transaction from Horizon and assert the
//      memo, amount, destination, and asset that ACTUALLY landed on-chain
//      match what was asked for
//   4. assert the input-validation guards reject bad input before signing
//
// Step 3 is the point of the test. The reason send-raw exists is that the
// hand-rolled `stellar tx new payment --build-only` → patch JSON → encode
// pipeline could silently drop the memo, and a deposit that arrives without
// its memo is money that is never credited. Asserting on the locally built
// transaction would re-test our own intent; asserting on what Horizon stored
// tests the wire.
//
// Native XLM is used deliberately: every Friendbot-funded account holds XLM,
// so the test needs no trustline and no USDC faucet. The payment code path is
// asset-agnostic.
//
// Usage:
//   ./node_modules/.bin/tsx scripts/smoke-test-send-raw.ts
//
// Exit code: 0 on success, non-zero on any failure.

import { Keypair, Horizon } from "@stellar/stellar-sdk";
import {
  sendRaw,
  normalizeAmount,
  resolveMemo,
  resolveAsset,
  toStroops,
  type CmdArgs,
} from "../skills/send-raw/run.js";
import type { BaseConfig } from "./src/cli-config.js";

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";

const TEST_AMOUNT = "1.2345678"; // 7 decimals — the maximum Stellar allows
const TEST_MEMO = "smoke-57985500";

function log(msg: string) {
  console.log(`[smoke] ${msg}`);
}

function fail(msg: string, err?: unknown): never {
  console.error(`[smoke] FAIL: ${msg}`);
  if (err) console.error(err);
  process.exit(1);
}

/** Friendbot has a history of TLS resets and 5xxs under load — retry with backoff. */
async function friendbotFund(address: string, label: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT}?addr=${address}`);
      if (res.ok) return;
      const body = await res.text();
      if (body.includes("createAccountAlreadyExist") || body.includes("already funded")) {
        return;
      }
      throw new Error(`Friendbot ${label} returned ${res.status}: ${body}`);
    } catch (e: any) {
      if (attempt === maxAttempts) {
        fail(`Friendbot ${label} failed after ${maxAttempts} attempts`, e);
      }
      const delayMs = 1000 * Math.pow(2, attempt - 1);
      log(
        `  Friendbot ${label} attempt ${attempt} failed (${e.message ?? e}); retrying in ${delayMs}ms...`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** Assert that a call rejects, and that the message explains why. */
async function expectReject(
  label: string,
  fn: () => Promise<unknown>,
  expectFragment: string,
): Promise<void> {
  try {
    await fn();
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!msg.includes(expectFragment)) {
      fail(`${label}: rejected but message lacks "${expectFragment}" — got: ${msg}`);
    }
    log(`  ✓ ${label}`);
    return;
  }
  fail(`${label}: expected a rejection, got success`);
}

async function testValidationGuards(): Promise<void> {
  log("Checking input-validation guards (no network, no signing)...");

  await expectReject(
    "amount with 8 decimals is rejected",
    async () => normalizeAmount("1.00000001"),
    "at most 7",
  );
  await expectReject(
    "non-numeric amount is rejected",
    async () => normalizeAmount("1.05 USDC"),
    "positive decimal",
  );
  await expectReject(
    "zero amount is rejected",
    async () => normalizeAmount("0"),
    "greater than zero",
  );
  await expectReject(
    "over-long MEMO_TEXT is rejected",
    () => resolveMemo("x".repeat(29), "text"),
    "28 bytes",
  );
  await expectReject(
    "multi-byte MEMO_TEXT over the BYTE limit is rejected",
    // 10 CJK characters = 30 UTF-8 bytes, but only 10 JS characters. A naive
    // .length check would let this through and Horizon would reject the tx.
    () => resolveMemo("字".repeat(10), "text"),
    "28 bytes",
  );
  await expectReject(
    "non-numeric MEMO_ID is rejected",
    () => resolveMemo("not-a-number", "id"),
    "unsigned integer",
  );
  await expectReject(
    "short MEMO_HASH is rejected",
    () => resolveMemo("deadbeef", "hash"),
    "64 hex",
  );
  await expectReject(
    "bare unknown asset code is rejected",
    () => resolveAsset("EURC", "testnet"),
    "CODE:ISSUER",
  );
  await expectReject(
    "asset with a bad issuer is rejected",
    () => resolveAsset("EURC:not-a-key", "testnet"),
    "not a valid Stellar public key",
  );
  await expectReject(
    // Destructuring a 3-way split would silently use the first issuer and
    // pay the wrong token, irreversibly.
    "asset spec with an extra component is rejected",
    () =>
      resolveAsset(
        "EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        "testnet",
      ),
    "not understood",
  );
  await expectReject(
    // The confirmation prompt is the last human check; a memo carrying ANSI
    // escapes could rewrite it after the destination has been printed.
    "MEMO_TEXT with ANSI escapes is rejected",
    () => resolveMemo("ok\u001b[2J\u001b[Hevil", "text"),
    "control characters",
  );
  await expectReject(
    "MEMO_TEXT with a bare newline is rejected",
    () => resolveMemo("line1\nline2", "text"),
    "control characters",
  );

  // Stroop conversion must be exact — float math at the boundary either
  // refuses an affordable payment or submits an unaffordable one.
  const stroopCases: Array<[string, bigint]> = [
    ["1.0500", 10_500_000n],
    ["0.0000001", 1n],
    ["1", 10_000_000n],
    ["123.4567891", 1_234_567_891n],
  ];
  for (const [input, want] of stroopCases) {
    const got = toStroops(input);
    if (got !== want) fail(`toStroops("${input}") = ${got}, want ${want}`);
  }
  log("  ✓ stroop conversion is exact");

  // A 28-byte multi-byte memo is exactly at the limit and must be accepted.
  const boundary = "字".repeat(9) + "x"; // 27 + 1 = 28 bytes
  if (Buffer.byteLength(boundary, "utf8") !== 28) {
    fail(`test setup wrong: boundary memo is ${Buffer.byteLength(boundary, "utf8")} bytes`);
  }
  if (!(await resolveMemo(boundary, "text"))) {
    fail("28-byte MEMO_TEXT should be accepted at the boundary");
  }
  log("  ✓ 28-byte MEMO_TEXT accepted at the boundary");

  // Amounts must survive verbatim — an exact-match deposit breaks otherwise.
  if (normalizeAmount("1.0500") !== "1.0500") {
    fail(`normalizeAmount reformatted "1.0500" to "${normalizeAmount("1.0500")}"`);
  }
  log("  ✓ trailing-zero amount preserved verbatim");
}

async function main() {
  await testValidationGuards();

  log("Generating throwaway sender + recipient...");
  const senderKp = Keypair.random();
  const recipientKp = Keypair.random();
  log(`  sender:    ${senderKp.publicKey()}`);
  log(`  recipient: ${recipientKp.publicKey()}`);

  log("Funding both via Friendbot...");
  await friendbotFund(senderKp.publicKey(), "sender");
  await friendbotFund(recipientKp.publicKey(), "recipient");
  log("  both funded.");

  const base: BaseConfig = {
    secretFile: "(unused — secret passed directly)",
    network: "testnet",
    horizonUrl: HORIZON_TESTNET,
    rpcUrl: "https://soroban-testnet.stellar.org",
  };

  const args: CmdArgs = {
    to: recipientKp.publicKey(),
    amount: TEST_AMOUNT,
    asset: "XLM",
    memo: TEST_MEMO,
    memoType: "text",
    json: false,
    yes: true, // non-interactive; testnet only
  };

  log("Guard check: paying a nonexistent destination must be refused...");
  await expectReject(
    "unfunded destination is refused before signing",
    () =>
      sendRaw({
        base,
        secret: senderKp.secret(),
        args: { ...args, to: Keypair.random().publicKey() },
      }),
    "does not exist",
  );

  log("Guard check: self-payment must be refused...");
  await expectReject(
    "self-payment is refused",
    () =>
      sendRaw({
        base,
        secret: senderKp.secret(),
        args: { ...args, to: senderKp.publicKey() },
      }),
    "own address",
  );

  log("Guard check: a C... contract destination must be refused...");
  await expectReject(
    "contract destination is refused",
    () =>
      sendRaw({
        base,
        secret: senderKp.secret(),
        args: {
          ...args,
          to: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        },
      }),
    "Soroban contract address",
  );

  log("Guard check: sending more than the balance must be refused...");
  await expectReject(
    "overdraft is refused before signing",
    () =>
      sendRaw({ base, secret: senderKp.secret(), args: { ...args, amount: "999999" } }),
    "Insufficient",
  );

  log("Submitting the real payment...");
  const result = await sendRaw({ base, secret: senderKp.secret(), args });

  if (!result.hash || result.hash.length !== 64) {
    fail(`tx hash looks wrong: ${result.hash}`);
  }
  log(`  submitted: ${result.hash}`);

  // The assertion that matters: read back what Horizon actually stored.
  log("Re-reading the transaction from Horizon...");
  const horizon = new Horizon.Server(HORIZON_TESTNET);
  const onChain: any = await horizon.transactions().transaction(result.hash).call();

  if (onChain.memo_type !== "text") {
    fail(`on-chain memo_type is "${onChain.memo_type}", want "text"`);
  }
  if (onChain.memo !== TEST_MEMO) {
    fail(
      `on-chain memo is "${onChain.memo}", want "${TEST_MEMO}" — ` +
        `the memo was dropped or mangled between build and submit. This is the ` +
        `exact failure mode send-raw exists to prevent.`,
    );
  }
  log(`  ✓ memo landed on-chain: "${onChain.memo}" (${onChain.memo_type})`);

  if (onChain.source_account !== senderKp.publicKey()) {
    fail(`on-chain source is ${onChain.source_account}, want ${senderKp.publicKey()}`);
  }
  if (!onChain.successful) {
    fail("Horizon reports the transaction as unsuccessful");
  }

  const ops: any = await horizon.operations().forTransaction(result.hash).call();
  if (ops.records.length !== 1) {
    fail(`expected exactly 1 operation, got ${ops.records.length}`);
  }
  const op = ops.records[0];
  if (op.type !== "payment") fail(`expected a payment op, got "${op.type}"`);
  if (op.to !== recipientKp.publicKey()) {
    fail(`payment went to ${op.to}, want ${recipientKp.publicKey()}`);
  }
  if (op.asset_type !== "native") {
    fail(`expected native asset, got "${op.asset_type}"`);
  }
  if (Number(op.amount) !== Number(TEST_AMOUNT)) {
    fail(`on-chain amount is ${op.amount}, want ${TEST_AMOUNT}`);
  }
  log(`  ✓ payment op: ${op.amount} XLM → ${op.to}`);

  log("");
  log("✅ PASS — send-raw verified end-to-end on testnet.");
}

main().catch((e) => fail("unexpected error", e));
