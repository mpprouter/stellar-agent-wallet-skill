// Smoke test for readAutopayCeiling / writeAutopayCeiling.
// Filename prefix "smoke-test-" — excluded from build artifacts.
import { readAutopayCeiling, writeAutopayCeiling } from "./src/secret.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = path.join(os.tmpdir(), `secret-autopay-${Date.now()}.txt`);
const body = `# Stellar wallet secret — DO NOT COMMIT. chmod 600.
SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX
`;
fs.writeFileSync(tmp, body, { mode: 0o600 });

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("  ok:", msg);
}

assert(readAutopayCeiling(tmp) === 0, "initial ceiling is 0");

writeAutopayCeiling(tmp, 0.1);
assert(readAutopayCeiling(tmp) === 0.1, "ceiling 0.10 after write");
assert(
  fs.readFileSync(tmp, "utf8").includes("SABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
  "secret body preserved",
);

writeAutopayCeiling(tmp, 0.25);
assert(readAutopayCeiling(tmp) === 0.25, "ceiling updated to 0.25");
const afterUpdate = fs.readFileSync(tmp, "utf8");
assert(
  (afterUpdate.match(/autopay-ceiling-usd/g) ?? []).length === 1,
  "only one directive line after overwrite",
);

writeAutopayCeiling(tmp, 0);
assert(readAutopayCeiling(tmp) === 0, "ceiling removed on write(0)");
assert(
  !fs.readFileSync(tmp, "utf8").includes("autopay-ceiling-usd"),
  "directive line removed",
);
assert(
  fs.readFileSync(tmp, "utf8").includes("SABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
  "secret body still preserved after revoke",
);

const mode = fs.statSync(tmp).mode & 0o777;
assert(mode === 0o600, `mode is 600 (got ${mode.toString(8)})`);

// Missing file → 0, no throw.
assert(readAutopayCeiling("/nonexistent/path") === 0, "missing file returns 0");

// Garbage values → 0.
fs.writeFileSync(tmp, "# autopay-ceiling-usd: -5\nSABCDEF\n", { mode: 0o600 });
assert(readAutopayCeiling(tmp) === 0, "negative value treated as 0");

fs.writeFileSync(tmp, "# autopay-ceiling-usd: abc\nSABCDEF\n", { mode: 0o600 });
assert(readAutopayCeiling(tmp) === 0, "non-numeric value treated as 0");

fs.unlinkSync(tmp);
console.log("\nall autopay smoke tests passed.");
