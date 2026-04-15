// Smoke test: verify onboard can statically import the refactored
// runAddTrustline and runSwap symbols without triggering their CLI
// main() functions at import time.
import { runAddTrustline } from "../skills/check-balance/add-trustline.js";
import { runSwap, type SwapArgs } from "../skills/check-balance/swap-xlm-to-usdc.js";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("  ok:", msg);
}

assert(typeof runAddTrustline === "function", "runAddTrustline is a function");
assert(typeof runSwap === "function", "runSwap is a function");

const args: SwapArgs = { mode: "xlm", amount: "1", slippage: 0.01, yes: false };
assert(args.mode === "xlm", "SwapArgs type usable");

console.log("\nall onboard-import smoke tests passed.");
