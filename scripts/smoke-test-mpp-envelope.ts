#!/usr/bin/env node
/**
 * MPP envelope round-trip smoke test — pure unit test, no network.
 *
 * Gate for the v1.1.3 bug class: `encodeMppHeader` producing an
 * Authorization header that mppx.Credential.deserialize can't parse
 * (wrong wire shape, bad DID, non-canonical request, re-encoded opaque).
 *
 * Flow:
 *   1. Synthesize a real MPP challenge via mppx.Challenge.from with an
 *      HMAC secretKey (cryptographically binds `id` to the full challenge).
 *   2. Serialize it via mppx.Challenge.serialize → WWW-Authenticate value.
 *   3. Build a fake 402 Response carrying that header.
 *   4. Run our parse402() to round-trip the header into a ParsedChallenge.
 *   5. Call encodeMppHeader() with a dummy signed XDR (the signing path
 *      itself is covered by smoke-test-sign.ts, which needs testnet; this
 *      test covers only the wire envelope layer, so it runs anywhere).
 *   6. Hand the resulting Authorization header back to mppx.Credential
 *      .deserialize — this is the assertion: if mppx can deserialize what
 *      we serialized, the wire shape is correct. It also independently
 *      walks the Challenge.Schema zod parser, catching any shape drift.
 *   7. Extra asserts: challenge.id round-tripped exactly, opaque preserved,
 *      DID has exactly the right `did:pkh:<network>:<pubkey>` shape.
 *
 * Exit code: 0 on success, non-zero on any failure. No network required.
 */

import * as mppx from "mppx";
import { parse402 } from "./src/pay-engine.js";
import { encodeMppHeader, type MppChallenge } from "./src/mpp-envelope.js";

function log(msg: string) {
  console.log(`[envelope-smoke] ${msg}`);
}

function fail(msg: string, err?: unknown): never {
  console.error(`[envelope-smoke] FAIL: ${msg}`);
  if (err) console.error(err);
  process.exit(1);
}

// Fake-but-structurally-valid signed XDR. encodeMppHeader doesn't parse
// it — it only base64-wraps it into the credential payload — so any
// non-empty string works here. The real XDR path is exercised by
// smoke-test-sign.ts (needs testnet).
const FAKE_SIGNED_XDR = "AAAAAgAAAAA=";

// A realistic pubnet USDC SAC contract address — format only matters
// to the extent that parse402 passes it through.
const USDC_SAC =
  "CAQCFVLOBK5GIULPNZRGSXFPMIDUTASYVCUXBKQWUYSQAI46TUCCDOQP";
const PAY_TO =
  "GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP";
const SIGNER_PUBKEY =
  "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

async function main() {
  log("Synthesizing MPP challenge via mppx.Challenge.from (HMAC-bound)...");
  // Note: per mppx.Challenge.from, `secretKey` lives on the first
  // parameter object — not in the second `options` arg. Passing it
  // under options silently drops it, and the schema then rejects
  // the missing `id`.
  const challenge = mppx.Challenge.from({
    realm: "apiserver.mpprouter.dev",
    method: "stellar",
    intent: "charge",
    expires: "2099-12-31T23:59:59Z",
    request: {
      amount: "1000",
      currency: USDC_SAC,
      recipient: PAY_TO,
      methodDetails: {
        network: "stellar:pubnet",
        feePayer: true,
        maxTimeoutSeconds: 120,
      },
    },
    meta: {
      // Flat string->string correlation data — mppx schema is strict.
      upstream: "parallel.ai/search",
      route: "v1-charge",
    },
    secretKey: "unit-test-server-secret",
  });
  log(`  challenge.id = ${challenge.id}`);

  log("Serializing challenge → WWW-Authenticate header value...");
  const wwwAuthenticate = mppx.Challenge.serialize(challenge);
  log(`  header: ${wwwAuthenticate.slice(0, 80)}...`);

  log("Building mock 402 Response...");
  const mock402 = new Response(null, {
    status: 402,
    headers: { "WWW-Authenticate": wwwAuthenticate },
  });

  log("Running parse402()...");
  const parsed = await parse402(mock402);
  if (!parsed) fail("parse402 returned null");
  if (parsed.dialect !== "mpp") fail(`expected mpp dialect, got ${parsed.dialect}`);
  if (parsed.amount !== "1000") fail(`amount mismatch: ${parsed.amount}`);
  if (parsed.asset !== USDC_SAC) fail(`asset mismatch: ${parsed.asset}`);
  if (parsed.payTo !== PAY_TO) fail(`payTo mismatch: ${parsed.payTo}`);
  if (parsed.maxTimeoutSeconds !== 120)
    fail(`maxTimeoutSeconds mismatch: ${parsed.maxTimeoutSeconds}`);

  const raw = parsed.raw as MppChallenge;
  if (raw.id !== challenge.id) fail(`challenge.id not round-tripped: ${raw.id}`);
  if (raw.realm !== challenge.realm) fail(`realm mismatch`);
  if (!raw.opaque || raw.opaque.upstream !== "parallel.ai/search")
    fail("opaque not round-tripped through parse402");
  log("  parse402 round-trip OK");

  log("Running encodeMppHeader() with fake signed XDR...");
  const authHeader = encodeMppHeader(FAKE_SIGNED_XDR, SIGNER_PUBKEY, raw);
  log(`  header: ${authHeader.slice(0, 80)}...`);

  log("Handing header to mppx.Credential.deserialize()...");
  let credential;
  try {
    credential = mppx.Credential.deserialize(authHeader);
  } catch (e) {
    fail(
      "mppx.Credential.deserialize threw — wire shape is out of sync with mppx",
      e,
    );
  }

  // Post-deserialize assertions — the important ones.
  if (credential.challenge.id !== challenge.id) {
    fail(
      `HMAC-bound id drifted through serialize+deserialize: ` +
        `${credential.challenge.id} vs ${challenge.id}`,
    );
  }
  // If the request wasn't canonicalized the same way, zod still accepts it
  // but the HMAC check would fail on the server. mppx.Challenge.verify
  // re-hashes the challenge and compares — use it as the authoritative gate.
  try {
    mppx.Challenge.verify(credential.challenge, {
      secretKey: "unit-test-server-secret",
    });
  } catch (e) {
    fail(
      "Challenge HMAC verify failed after round-trip — this means " +
        "encodeMppHeader is not canonicalizing `request` or `opaque` " +
        "the same way mppx does. The server will reject this credential.",
      e,
    );
  }

  const expectedSource = `did:pkh:stellar:pubnet:${SIGNER_PUBKEY}`;
  if (credential.source !== expectedSource) {
    fail(
      `source DID mismatch: ${credential.source} vs ${expectedSource}`,
    );
  }

  const payload = credential.payload as { type?: string; transaction?: string };
  if (payload?.type !== "transaction") fail(`payload.type: ${payload?.type}`);
  if (payload?.transaction !== FAKE_SIGNED_XDR)
    fail(`payload.transaction mismatch`);

  log("");
  log("✅ PASS — MPP envelope round-trips through mppx and HMAC verifies.");
  process.exit(0);
}

main().catch((e) => fail("unexpected error", e));
