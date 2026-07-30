// Smoke test for the plaintext-key runtime note. Excluded from build
// artifacts via the smoke-test-* prefix filter in plugin/build-lib.mjs.
import { loadSecretWithSource } from "./src/secret.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("  ok:", msg);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-note-"));
const secretFile = path.join(dir, ".stellar-secret");
fs.writeFileSync(
  secretFile,
  "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW\n",
  { mode: 0o600 },
);

// Capture stderr around each load.
const lines: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };

loadSecretWithSource(secretFile);
const afterFirst = lines.length;
loadSecretWithSource(secretFile);
const afterSecond = lines.length;

console.error = realError;
fs.rmSync(dir, { recursive: true, force: true });

const joined = lines.join("\n");
assert(afterFirst > 0, "plaintext load prints a note");
assert(joined.includes("plaintext"), "note says the key is plaintext");
assert(joined.includes(secretFile), "note names the source path");
assert(joined.includes("--identity"), "note points at the safer alternative");
assert(
  !joined.includes("SABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
  "note never echoes the secret itself",
);
assert(afterSecond === afterFirst, "note prints at most once per process");

console.log("secret note smoke test passed");
