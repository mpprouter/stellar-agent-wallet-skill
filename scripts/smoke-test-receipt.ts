// Smoke test for decodeReceipt / explorerUrl. Excluded from builds via the
// smoke-test-* prefix filter in plugin/build-lib.mjs.
import { decodeReceipt, explorerUrl } from "./src/receipt.js";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("  ok:", msg);
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

const TX_HASH = "9aa69d2e" + "c".repeat(56);   // 64 hex chars

// 1. Single-segment receipt (the MPP Router shape).
const single = decodeReceipt(
  b64({
    method: "stellar",
    reference: TX_HASH,
    amount: "250000",
    payTo: "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB",
    timestamp: 1753884033,
  }),
);
assert(single.txHash === TX_HASH, "single-segment: tx hash from `reference`");
assert(
  single.payTo === "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB",
  "single-segment: payTo",
);
assert(single.timestamp === "2025-07-30T14:00:33.000Z", "single-segment: unix → ISO");

// 2. Ambiguous units are never guessed. A bare integer is both N USDC and
// N base units; reporting either would be a 10^7 error, so we report
// nothing and let the caller fall back to the 402 challenge.
assert(single.amount === undefined, "integer amount is left undecided, not guessed");
assert(
  decodeReceipt(b64({ amount: "1" })).amount === undefined,
  "bare \"1\" is not silently read as 0.0000001 USDC",
);

// 3. An explicit transaction field beats the generic `reference`, and a
// reference that is not a well-formed hash never becomes an explorer link.
const both = decodeReceipt(b64({ reference: "pl_abc123", transaction: TX_HASH }));
assert(both.txHash === TX_HASH, "explicit `transaction` wins over `reference`");
assert(
  decodeReceipt(b64({ reference: "pl_abc123" })).txHash === undefined,
  "non-hash `reference` is rejected rather than linked",
);

// 4. Classic JWT shape — payload in segment 1, unparseable signature skipped.
const jwt = decodeReceipt(
  `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    amount: "0.025",
    destination: "GABC",
    transaction: TX_HASH,
  })}.c2lnbmF0dXJl`,
);
assert(jwt.txHash === TX_HASH, "jwt: tx hash from `transaction`");
assert(jwt.amount === "0.025", "jwt: decimal amount passes through unambiguously");
assert(jwt.payTo === "GABC", "jwt: payTo from `destination`");

// 5. Undecodable receipt → empty summary, never throws.
const junk = decodeReceipt("not-a-receipt");
assert(
  junk.txHash === undefined && junk.amount === undefined && junk.payTo === undefined,
  "undecodable receipt → empty summary",
);

// 6. Explorer URLs are network-correct.
assert(
  explorerUrl("abc", "pubnet") === "https://stellar.expert/explorer/public/tx/abc",
  "pubnet explorer url",
);
assert(
  explorerUrl("abc", "testnet") === "https://stellar.expert/explorer/testnet/tx/abc",
  "testnet explorer url",
);

console.log("receipt smoke test passed");
