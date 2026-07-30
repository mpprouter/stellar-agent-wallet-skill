// Smoke test for decodeReceipt / explorerUrl. Excluded from builds via the
// smoke-test-* prefix filter in plugin/build-lib.mjs.
import { decodeReceipt, explorerUrl } from "./src/receipt.js";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("  ok:", msg);
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

// 1. Single-segment receipt in base units (the MPP Router shape).
const single = decodeReceipt(
  b64({
    method: "stellar",
    reference: "9aa69d2ecafe",
    amount: "250000",
    payTo: "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB",
    timestamp: 1753884033,
  }),
);
assert(single.txHash === "9aa69d2ecafe", "single-segment: tx hash from `reference`");
assert(single.amount === "0.0250000", "single-segment: base units → human USDC");
assert(
  single.payTo === "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB",
  "single-segment: payTo",
);
assert(single.timestamp === "2025-07-30T14:00:33.000Z", "single-segment: unix → ISO");

// 2. Classic JWT shape — payload in segment 1, unparseable signature skipped.
const jwt = decodeReceipt(
  `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    amount: "0.025",
    destination: "GABC",
    transaction: "deadbeef",
  })}.c2lnbmF0dXJl`,
);
assert(jwt.txHash === "deadbeef", "jwt: tx hash from `transaction`");
assert(jwt.amount === "0.025", "jwt: already-human amount passes through");
assert(jwt.payTo === "GABC", "jwt: payTo from `destination`");

// 3. Undecodable receipt → empty summary, never throws.
const junk = decodeReceipt("not-a-receipt");
assert(
  junk.txHash === undefined && junk.amount === undefined && junk.payTo === undefined,
  "undecodable receipt → empty summary",
);

// 4. Explorer URLs are network-correct.
assert(
  explorerUrl("abc", "pubnet") === "https://stellar.expert/explorer/public/tx/abc",
  "pubnet explorer url",
);
assert(
  explorerUrl("abc", "testnet") === "https://stellar.expert/explorer/testnet/tx/abc",
  "testnet explorer url",
);

console.log("receipt smoke test passed");
