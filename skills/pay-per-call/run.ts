/**
 * pay-per-call — call a 402-gated endpoint and pay with Stellar USDC.
 *
 * Supports two 402 dialects:
 *   1. x402 — body contains { x402Version, accepts: [PaymentRequirements] }
 *   2. MPP  — WWW-Authenticate: Payment request=<base64-json> header
 *
 * Usage:
 *   npx tsx skills/pay-per-call/run.ts <url> [--method POST] [--body '{}'] [--yes]
 *                                        [--max-auto <usd>] [--receipt-out <path>]
 *                                        [--json] [base flags]
 *
 * Base flags: --secret-file, --network, --rpc-url (see cli-config.ts)
 */

import {
  parse402,
  buildRetryHeaders,
  baseUnitsToUsdc,
  validateChallenge,
  type ChallengeExpectations,
  type ParsedChallenge,
} from "../../scripts/src/pay-engine.js";
import type { SignerConfig } from "../../scripts/src/stellar-signer.js";
import { parseBase, type BaseConfig } from "../../scripts/src/cli-config.js";
import {
  loadSecretFromFile,
  readAutopayCeiling,
  writeAutopayCeiling,
} from "../../scripts/src/secret.js";

interface CmdArgs {
  url?: string;
  method: string;
  body?: string;
  json: boolean;
  yes: boolean;
  /** Explicit per-invocation ceiling. undefined → use ceiling from secret file. */
  maxAutoUsd?: number;
  receiptOut?: string;
  /** Force a prompt even if the autopay ceiling would allow auto-pay. */
  noAutopay: boolean;
  /** Expected 402 challenge fields. Any mismatch aborts before signing. */
  expectPayTo?: string;
  expectAsset?: string;
  expectAmountUsdc?: string;
  expectAmountTolerance?: number;
}

function parseCmdArgs(rest: string[]): CmdArgs {
  const a: CmdArgs = { method: "GET", json: false, yes: false, noAutopay: false };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === "--method") a.method = rest[++i];
    else if (k === "--body") a.body = rest[++i];
    else if (k === "--json") a.json = true;
    else if (k === "--yes" || k === "-y") a.yes = true;
    else if (k === "--max-auto") {
      const v = parseFloat(rest[++i]);
      if (!Number.isFinite(v) || v < 0) {
        console.error("--max-auto must be a non-negative number");
        process.exit(1);
      }
      a.maxAutoUsd = v;
    } else if (k === "--no-autopay") a.noAutopay = true;
    else if (k === "--receipt-out") a.receiptOut = rest[++i];
    else if (k === "--expect-pay-to") a.expectPayTo = rest[++i];
    else if (k === "--expect-asset") a.expectAsset = rest[++i];
    else if (k === "--expect-amount") a.expectAmountUsdc = rest[++i];
    else if (k === "--expect-amount-tolerance") {
      const v = parseFloat(rest[++i]);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        console.error("--expect-amount-tolerance must be between 0 and 1");
        process.exit(1);
      }
      a.expectAmountTolerance = v;
    } else if (!k.startsWith("--") && !a.url) a.url = k;
  }
  return a;
}

interface RunInputs {
  base: BaseConfig;
  args: CmdArgs;
  signerConfig: SignerConfig;
}

function resolveInputs(): RunInputs {
  const { base, rest } = parseBase(process.argv.slice(2));
  const args = parseCmdArgs(rest);
  if (!args.url) {
    console.error("Usage: pay-per-call.ts <url> [--method POST] [--body '{...}']");
    process.exit(1);
  }
  const secret = loadSecretFromFile(base.secretFile);
  const signerConfig: SignerConfig = {
    secret,
    network: base.network,
    rpcUrl: base.rpcUrl,
  };
  return { base, args, signerConfig };
}

async function promptConfirm(message: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ans = await rl.question(message);
  rl.close();
  return ans.trim().toLowerCase() === "yes";
}

async function promptLine(message: string): Promise<string> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ans = await rl.question(message);
  rl.close();
  return ans.trim();
}

/**
 * Decide whether this payment needs a human confirmation, and offer
 * to enroll the wallet in autopay after the first confirmed mainnet
 * payment.
 *
 * Ordering, least-surprising-first:
 *   1. Testnet or --yes → no prompt.
 *   2. --no-autopay → always prompt (defeats saved ceiling for one call).
 *   3. Explicit --max-auto N → auto-pay if amount ≤ N, else prompt.
 *      Does NOT touch the saved ceiling.
 *   4. Saved autopay-ceiling-usd in secret file → auto-pay if amount ≤ it.
 *   5. No ceiling → prompt. After user confirms, offer to save a
 *      ceiling so future small payments are silent.
 *
 * Auto-pay always logs `[autopay] $X to G...` to stderr so there is a
 * trail, even when silent.
 */
async function gateMainnetPayment(opts: {
  amountUsd: number;
  humanAmount: string;
  args: CmdArgs;
  secretFile: string;
  network: "testnet" | "pubnet";
}): Promise<void> {
  const { amountUsd, humanAmount, args, secretFile, network } = opts;

  if (network !== "pubnet") return;
  if (args.yes) return;

  if (!args.noAutopay) {
    if (args.maxAutoUsd !== undefined) {
      if (amountUsd <= args.maxAutoUsd) {
        console.error(
          `[autopay] $${humanAmount} USDC (≤ --max-auto $${args.maxAutoUsd.toFixed(2)})`,
        );
        return;
      }
    } else {
      const savedCeiling = readAutopayCeiling(secretFile);
      if (savedCeiling > 0 && amountUsd <= savedCeiling) {
        console.error(
          `[autopay] $${humanAmount} USDC (≤ saved ceiling $${savedCeiling.toFixed(2)})`,
        );
        return;
      }
    }
  }

  const ok = await promptConfirm(
    `Pay $${humanAmount} USDC on mainnet? (yes/no) `,
  );
  if (!ok) {
    console.error("Aborted.");
    process.exit(0);
  }

  // Post-confirm enrollment: only offer if the user hasn't already
  // picked a ceiling, hasn't overridden with --max-auto, and isn't
  // forcing prompts via --no-autopay.
  if (args.noAutopay) return;
  if (args.maxAutoUsd !== undefined) return;
  const existing = readAutopayCeiling(secretFile);
  if (existing > 0) return;

  console.error("");
  console.error(
    "💡 Tip: you can auto-approve small payments below a ceiling you choose.",
  );
  console.error(
    "    Future calls ≤ the ceiling will be paid silently; larger ones still prompt.",
  );
  const ans = await promptLine(
    "    Set an autopay ceiling (USD) now? [blank = skip, e.g. 0.10]: ",
  );
  if (!ans) return;
  const ceiling = parseFloat(ans);
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    console.error("    Skipped (invalid amount).");
    return;
  }
  try {
    writeAutopayCeiling(secretFile, ceiling);
    console.error(
      `    ✅ Saved autopay ceiling $${ceiling.toFixed(2)} to ${secretFile}.`,
    );
    console.error(
      `       Remove the '# autopay-ceiling-usd:' line in that file to revoke.`,
    );
  } catch (err) {
    console.error(`    ⚠️  Could not write ceiling: ${(err as Error).message}`);
  }
}

async function dumpResponse(res: Response, jsonMode: boolean) {
  if (!res.ok && res.status !== 202) {
    console.error(`❌ ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    const json = await res.json();
    console.log(jsonMode ? JSON.stringify(json) : JSON.stringify(json, null, 2));
  } else {
    console.log(await res.text());
  }
}

/**
 * Poll an async job until it completes or times out.
 * Uses the same auth headers from the initial request so the
 * router can verify the caller is the original payer.
 */
async function pollJobStatus(
  pollUrl: string,
  authHeaders: HeadersInit,
  jsonMode: boolean,
  intervalMs = 5000,
  timeoutMs = 600000, // 10 minutes
): Promise<boolean> {
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < timeoutMs) {
    attempt++;
    await new Promise((r) => setTimeout(r, intervalMs));

    const res = await fetch(pollUrl, { headers: authHeaders });

    if (res.status === 202 || res.status === 200) {
      let body: any;
      try {
        body = await res.json();
      } catch {
        console.error(`   Attempt ${attempt}: non-JSON response (${res.status})`);
        continue;
      }

      const status = body.status ?? body.state ?? "";
      if (
        status === "pending" ||
        status === "processing" ||
        status === "in_progress"
      ) {
        console.error(`   Attempt ${attempt}: ${status}...`);
        continue;
      }

      // Job completed (or unknown status) — dump result
      console.error(`✅ Job completed after ${attempt} polls`);
      console.log(
        jsonMode ? JSON.stringify(body) : JSON.stringify(body, null, 2),
      );
      return true;
    }

    if (res.status === 404) {
      console.error(`❌ Job not found (expired or invalid)`);
      process.exit(1);
    }

    console.error(
      `   Attempt ${attempt}: unexpected status ${res.status}, retrying...`,
    );
  }

  console.error(`❌ Timeout after ${timeoutMs / 1000}s waiting for job`);
  process.exit(1);
}

function buildInit(method: string, body?: string): RequestInit {
  const canHaveBody = !["GET", "HEAD"].includes(method.toUpperCase());
  return {
    method,
    headers: body && canHaveBody ? { "Content-Type": "application/json" } : undefined,
    body: canHaveBody ? body : undefined,
  };
}

/**
 * Ask the response whether the path exists under a different HTTP method.
 * Modern router replies 405 with `allowed_methods`; older deployments
 * reply 400 with the legacy "Unknown public service route" string and
 * no hint, so we fall back to probing the catalog by public_path.
 */
async function detectMethodMismatch(
  url: string,
  res: Response,
): Promise<string | null> {
  if (res.status === 405) {
    try {
      const j = (await res.clone().json()) as { allowed_methods?: string[] };
      const m = j.allowed_methods?.[0];
      if (m) return m;
    } catch {}
    const allow = res.headers.get("allow");
    if (allow) return allow.split(",")[0].trim();
  }
  if (res.status === 400) {
    const u = new URL(url);
    if (!u.host.endsWith("mpprouter.dev")) return null;
    let body: string;
    try { body = await res.clone().text(); } catch { return null; }
    if (!body.includes("Unknown public service route")) return null;
    try {
      const cat = await fetch(`${u.origin}/v1/services/catalog`);
      if (!cat.ok) return null;
      const j = (await cat.json()) as { services?: Array<{ public_path: string; method: string }> };
      const hit = j.services?.find(s => s.public_path === u.pathname);
      return hit?.method ?? null;
    } catch { return null; }
  }
  return null;
}

async function runPayFlow(inputs: RunInputs): Promise<void> {
  const { args, signerConfig } = inputs;
  let init = buildInit(args.method, args.body);

  let res = await fetch(args.url!, init);

  const correctMethod = await detectMethodMismatch(args.url!, res);
  if (correctMethod && correctMethod.toUpperCase() !== args.method.toUpperCase()) {
    console.error(
      `⚠️  ${args.method} rejected; router says use ${correctMethod}. Retrying.`,
    );
    args.method = correctMethod;
    init = buildInit(args.method, args.body);
    res = await fetch(args.url!, init);
  }

  if (res.status !== 402) {
    await dumpResponse(res, args.json);
    return;
  }

  const challenge: ParsedChallenge | null = await parse402(res);
  if (!challenge) {
    console.error("❌ Got 402 but could not parse challenge.");
    console.error("   Body:", await res.text());
    process.exit(1);
  }

  const humanAmount = baseUnitsToUsdc(challenge.amount);
  console.error(`💸 Payment required (${challenge.dialect})`);
  console.error(`   Amount: ${humanAmount} USDC`);
  console.error(`   To:     ${challenge.payTo}`);
  console.error(`   Asset:  ${challenge.asset}`);
  console.error("");

  // Challenge validation. If the caller passed --expect-* flags (typically
  // piped through from `discover --pick-one --json`), verify the 402
  // response matches. Any mismatch means a server or intermediary is
  // attempting to redirect funds, inflate the price, or swap the asset.
  // Refuse to sign.
  const expectations: ChallengeExpectations = {
    payTo: args.expectPayTo,
    asset: args.expectAsset,
    amountUsdc: args.expectAmountUsdc,
    amountTolerance: args.expectAmountTolerance,
  };
  const hasAnyExpectation =
    expectations.payTo !== undefined ||
    expectations.asset !== undefined ||
    expectations.amountUsdc !== undefined;
  if (hasAnyExpectation) {
    const mismatches = validateChallenge(challenge, expectations);
    if (mismatches) {
      console.error("❌ Challenge does not match expected values:");
      for (const m of mismatches) console.error(`   - ${m}`);
      console.error("");
      console.error("   Refusing to sign. The 402 server may be compromised,");
      console.error("   the URL may be wrong, or the catalog is stale.");
      process.exit(3);
    }
    console.error("✓ Challenge matches --expect-* values.");
    console.error("");
  }

  const amountUsd = parseFloat(humanAmount);
  await gateMainnetPayment({
    amountUsd,
    humanAmount,
    args,
    secretFile: inputs.base.secretFile,
    network: signerConfig.network,
  });

  const retryHeaders = await buildRetryHeaders({
    challenge,
    signerConfig,
    baseHeaders: init.headers,
  });
  res = await fetch(args.url!, { ...init, headers: retryHeaders });

  const receipt = res.headers.get("payment-receipt");
  if (receipt && args.receiptOut) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(args.receiptOut, receipt);
    console.error(`📝 Receipt saved to ${args.receiptOut}`);
  } else if (receipt) {
    console.error(`📝 Payment-Receipt: ${receipt}`);
  }

  // Handle async 202 — poll until job completes
  if (res.status === 202) {
    const pollUrl = res.headers.get("x-job-poll-url");
    const jobId = res.headers.get("x-job-id");
    if (pollUrl) {
      console.error(`⏳ Async job started (id=${jobId ?? "unknown"})`);
      console.error(`   Poll URL: ${pollUrl}`);
      const result = await pollJobStatus(pollUrl, retryHeaders, args.json);
      if (result) return;
    } else {
      // No poll URL — just dump the 202 body
      await dumpResponse(res, args.json);
      return;
    }
  }

  await dumpResponse(res, args.json);
}

async function main() {
  const inputs = resolveInputs();
  await runPayFlow(inputs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
