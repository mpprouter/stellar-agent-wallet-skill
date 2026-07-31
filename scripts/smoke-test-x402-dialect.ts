#!/usr/bin/env node
/**
 * x402-dialect parsing smoke test — pure unit test, no network.
 *
 * Companion to smoke-test-mpp-envelope.ts, which covers the MPP side.
 * This one covers the two x402 branches of `parse402` plus the header
 * encoder, using a REAL 402 response captured from MPP Router on
 * 2026-07-31:
 *
 *   POST https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape
 *
 * The header constants below are verbatim from that response (the
 * challenge has long since expired, so they are inert test fixtures).
 * See references/402-dialects-showcase.md for the decoded walkthrough.
 *
 * Exit code: 0 on success, non-zero on any failure.
 */

import { parse402 } from "./src/pay-engine.js";
import { encodeX402Header, wrapX402 } from "./src/x402.js";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("  ok:", msg);
}

// ---------------------------------------------------------------------------
// Captured fixtures — real MPP Router 402, both dialects in one response.
// ---------------------------------------------------------------------------

/** `WWW-Authenticate` value: MPP dialect. */
const REAL_WWW_AUTHENTICATE =
  'Payment id="taXgfY5_EKUBYh17XrVS_5KzFpdCqfsox6POv9xYEVs", ' +
  'realm="apiserver.mpprouter.dev", method="stellar", intent="charge", ' +
  'request="eyJhbW91bnQiOiIyMDAwMCIsImN1cnJlbmN5IjoiQ0NXNjdUU1pWM1NTUzJIWE1CUTVKRkdDS0pOWEtaTTdVUVVXVVpQVVRIWFNUWkxFTzdTSk1JNzUiLCJtZXRob2REZXRhaWxzIjp7ImNyZWRlbnRpYWxUeXBlcyI6WyJ0cmFuc2FjdGlvbiJdLCJmZWVQYXllciI6dHJ1ZSwibmV0d29yayI6InN0ZWxsYXI6cHVibmV0In0sInJlY2lwaWVudCI6IkdESzNBVlczWUU2VUwzSjRXTE5LQk1QNjVLU1kzMllQVUtJT0M2UFhXNjVYSjNMRUczWUlEWFhCIn0", ' +
  'expires="2026-07-31T00:21:12.780Z", opaque="eyJyb3V0ZSI6ImZpcmVjcmF3bF9zY3JhcGUifQ"';

/** `Payment-Required` value: x402 v2 dialect, same underlying charge. */
const REAL_PAYMENT_REQUIRED = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: "https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape",
    },
    accepts: [
      {
        scheme: "exact",
        network: "stellar:pubnet",
        amount: "20000",
        asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
        payTo: "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB",
        maxTimeoutSeconds: 300,
        extra: { areFeesSponsored: true },
      },
    ],
  }),
  "utf8",
).toString("base64");

/** The `application/problem+json` body that shipped alongside them. */
const REAL_PROBLEM_BODY = JSON.stringify({
  type: "https://paymentauth.org/problems/payment-required",
  title: "Payment Required",
  status: 402,
  detail: "Payment is required.",
  challengeId: "taXgfY5_EKUBYh17XrVS_5KzFpdCqfsox6POv9xYEVs",
});

const PAY_TO = "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB";
const ASSET = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

function mock402(headers: Record<string, string>, body = REAL_PROBLEM_BODY) {
  return new Response(body, {
    status: 402,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

async function main() {
  // 1. Both dialects present → MPP wins (documented priority order).
  console.log("[x402-smoke] dialect priority");
  const both = await parse402(
    mock402({
      "www-authenticate": REAL_WWW_AUTHENTICATE,
      "payment-required": REAL_PAYMENT_REQUIRED,
    }),
  );
  assert(both !== null, "dual-dialect 402 parses");
  assert(both!.dialect === "mpp", "MPP header takes priority over x402");
  assert(both!.payTo === PAY_TO, "MPP payTo");
  assert(both!.amount === "20000", "MPP amount in base units");

  // 2. x402 v2 header alone → x402 branch, with maxTimeoutSeconds honoured.
  console.log("[x402-smoke] Payment-Required header branch");
  const hdr = await parse402(
    mock402({ "payment-required": REAL_PAYMENT_REQUIRED }),
  );
  assert(hdr !== null, "Payment-Required header parses");
  assert(hdr!.dialect === "x402", "dialect is x402");
  assert(hdr!.payTo === PAY_TO, "x402 payTo");
  assert(hdr!.asset === ASSET, "x402 asset (SAC contract id)");
  assert(hdr!.amount === "20000", "x402 amount in base units");
  assert(hdr!.maxTimeoutSeconds === 300, "maxTimeoutSeconds from challenge");

  // Both dialects must agree on the charge — this is what lets the client
  // sign ONE inner SAC transfer and choose the envelope afterwards.
  assert(
    both!.payTo === hdr!.payTo &&
      both!.amount === hdr!.amount &&
      both!.asset === hdr!.asset,
    "both dialects describe the same inner transfer",
  );

  // 3. x402Version round-trips into the payload (v2 must not become v1).
  console.log("[x402-smoke] X-Payment envelope");
  const version = (hdr!.raw as any).x402Version;
  assert(version === 2, "captured envelope is x402Version 2");
  const encoded = encodeX402Header(
    wrapX402("AAAAAgAAAAA=", "stellar:pubnet", version),
  );
  const roundTrip = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert(roundTrip.x402Version === 2, "X-Payment preserves x402Version 2");
  assert(roundTrip.scheme === "exact", "X-Payment scheme is exact");
  assert(roundTrip.network === "stellar:pubnet", "X-Payment network is CAIP-2");
  assert(
    roundTrip.payload.transaction === "AAAAAgAAAAA=",
    "X-Payment carries the signed XDR",
  );

  // 4. Legacy dialect — envelope in the JSON body, no headers at all.
  console.log("[x402-smoke] legacy body branch");
  const legacyBody = Buffer.from(REAL_PAYMENT_REQUIRED, "base64").toString(
    "utf8",
  );
  const legacy = await parse402(
    new Response(legacyBody, {
      status: 402,
      headers: { "content-type": "application/json" },
    }),
  );
  assert(legacy !== null, "legacy body envelope parses");
  assert(legacy!.dialect === "x402", "legacy dialect is x402");
  assert(legacy!.payTo === PAY_TO, "legacy payTo");

  // 5. A non-Payment WWW-Authenticate must not block the x402 fallback.
  //    (Servers behind an auth proxy routinely emit `Bearer` here.)
  console.log("[x402-smoke] non-Payment WWW-Authenticate falls through");
  const bearer = await parse402(
    mock402({
      "www-authenticate": 'Bearer realm="example", charset="UTF-8"',
      "payment-required": REAL_PAYMENT_REQUIRED,
    }),
  );
  assert(bearer !== null, "Bearer challenge does not abort parsing");
  assert(bearer!.dialect === "x402", "falls through to the x402 branch");

  // 6. Unsponsored fees must raise the specific error, not be swallowed
  //    into a generic null. Regression guard: `assertSponsored` used to sit
  //    inside the decode try/catch, so its message never reached the user.
  console.log("[x402-smoke] areFeesSponsored=false surfaces a real error");
  const unsponsored = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "stellar:pubnet",
          amount: "20000",
          asset: ASSET,
          payTo: PAY_TO,
          maxTimeoutSeconds: 300,
          extra: { areFeesSponsored: false },
        },
      ],
    }),
    "utf8",
  ).toString("base64");
  let threw: Error | null = null;
  try {
    await parse402(mock402({ "payment-required": unsponsored }));
  } catch (err) {
    threw = err as Error;
  }
  assert(threw !== null, "unsponsored 402 throws instead of returning null");
  assert(
    threw!.message.includes("areFeesSponsored"),
    "error names areFeesSponsored so the user can act on it",
  );

  // 7. Garbage headers degrade to null, not a crash.
  console.log("[x402-smoke] malformed input");
  assert(
    (await parse402(mock402({ "payment-required": "!!!not-base64!!!" }))) ===
      null,
    "undecodable Payment-Required → null",
  );
  assert(
    (await parse402(new Response("plain text", { status: 402 }))) === null,
    "non-JSON body with no headers → null",
  );

  console.log("[x402-smoke] all checks passed");
}

main().catch((err) => {
  console.error("[x402-smoke] FAIL:", err);
  process.exit(1);
});
