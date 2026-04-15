// Smoke test for validateChallenge. Excluded from builds via the
// smoke-test-* prefix filter in plugin/build-lib.mjs.
import {
  validateChallenge,
  type ParsedChallenge,
} from "./src/pay-engine.js";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("  ok:", msg);
}

const baseChallenge: ParsedChallenge = {
  dialect: "mpp",
  amount: "50000", // 0.005 USDC (5000 * 10^-7) → 0.0050000
  asset: "CAQCFVLOBK5GIULPNZRGSXF52TKNCXKTUHVP6JZTVHG5PXOBNRFYHNVN",
  payTo: "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB",
  maxTimeoutSeconds: 60,
  raw: {},
};

// 1. No expectations → null (permissive).
assert(validateChallenge(baseChallenge, {}) === null, "empty expectations → null");

// 2. All-matching → null.
assert(
  validateChallenge(baseChallenge, {
    payTo: baseChallenge.payTo,
    asset: baseChallenge.asset,
    amountUsdc: "0.005",
  }) === null,
  "all matching → null",
);

// 3. payTo mismatch → returns mismatch.
const hitPayTo = validateChallenge(baseChallenge, {
  payTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
});
assert(
  Array.isArray(hitPayTo) && hitPayTo.length === 1 && hitPayTo[0].includes("payTo"),
  "payTo mismatch reported",
);

// 4. Asset mismatch → returns mismatch.
const hitAsset = validateChallenge(baseChallenge, {
  asset: "CBADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDE",
});
assert(
  Array.isArray(hitAsset) && hitAsset.length === 1 && hitAsset[0].includes("asset"),
  "asset mismatch reported",
);

// 5. Amount mismatch (exact) → returns mismatch.
const hitAmount = validateChallenge(baseChallenge, { amountUsdc: "0.01" });
assert(
  Array.isArray(hitAmount) && hitAmount.length === 1 && hitAmount[0].includes("amount"),
  "amount mismatch reported (exact)",
);

// 6. Amount within tolerance → null.
assert(
  validateChallenge(baseChallenge, {
    amountUsdc: "0.00505",
    amountTolerance: 0.02, // 2%
  }) === null,
  "amount within 2% tolerance → null",
);

// 7. Amount outside tolerance → mismatch.
const hitTol = validateChallenge(baseChallenge, {
  amountUsdc: "0.006",
  amountTolerance: 0.01,
});
assert(
  Array.isArray(hitTol) && hitTol.length === 1,
  "amount outside 1% tolerance reported",
);

// 8. Multiple mismatches → all reported.
const multi = validateChallenge(baseChallenge, {
  payTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  asset: "CBADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDE",
  amountUsdc: "0.01",
});
assert(
  Array.isArray(multi) && multi.length === 3,
  "all three mismatches reported together",
);

// 9. Invalid amountUsdc expectation → reported as invalid.
const bad = validateChallenge(baseChallenge, { amountUsdc: "not-a-number" });
assert(
  Array.isArray(bad) && bad[0].includes("invalid"),
  "non-numeric expected amount is called out",
);

// 10. Negative expected amount → reported as invalid.
const neg = validateChallenge(baseChallenge, { amountUsdc: "-1" });
assert(
  Array.isArray(neg) && neg[0].includes("invalid"),
  "negative expected amount is called out",
);

console.log("\nall validateChallenge smoke tests passed.");
