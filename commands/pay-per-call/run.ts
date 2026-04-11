/**
 * pay-per-call — call a 402-gated endpoint and pay with Stellar USDC.
 *
 * Supports two 402 dialects:
 *   1. x402 — body contains { x402Version, accepts: [PaymentRequirements] }
 *   2. MPP  — WWW-Authenticate: Payment request=<base64-json> header
 *
 * Usage:
 *   npx tsx commands/pay-per-call/run.ts <url> [--method POST] [--body '{}'] [--yes]
 *                                        [--max-auto <usd>] [--receipt-out <path>]
 *                                        [--json]
 *
 * Env contract (loaded via loadSecret + readNetworkConfig, NOT in fetch scope):
 *   STELLAR_SECRET       required — signing key
 *   STELLAR_NETWORK      optional — "testnet" or "pubnet" (default: pubnet)
 *   STELLAR_RPC_URL      optional — Soroban RPC override
 */

import "dotenv/config";
import { loadSecret } from "../../scripts/src/secret.js";
import {
  parse402,
  buildRetryHeaders,
  baseUnitsToUsdc,
  type ParsedChallenge,
} from "../../scripts/src/pay-engine.js";
import type { SignerConfig } from "../../scripts/src/stellar-signer.js";

interface CliArgs {
  url?: string;
  method: string;
  body?: string;
  json: boolean;
  yes: boolean;
  maxAutoUsd: number;
  receiptOut?: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const a: CliArgs = { method: "GET", json: false, yes: false, maxAutoUsd: 1.0 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--method") a.method = argv[++i];
    else if (k === "--body") a.body = argv[++i];
    else if (k === "--json") a.json = true;
    else if (k === "--yes" || k === "-y") a.yes = true;
    else if (k === "--max-auto") a.maxAutoUsd = parseFloat(argv[++i]);
    else if (k === "--receipt-out") a.receiptOut = argv[++i];
    else if (!k.startsWith("--") && !a.url) a.url = k;
  }
  return a;
}

/**
 * Read the non-secret network config from env.
 *
 * Kept separate from secret loading (loadSecret) and from any function
 * that calls fetch. This helper's only job is translate env → plain config.
 */
function readNetworkConfig(): { network: "testnet" | "pubnet"; rpcUrl: string } {
  const network = (process.env.STELLAR_NETWORK ?? "pubnet") as
    | "testnet"
    | "pubnet";
  const rpcUrl =
    process.env.STELLAR_RPC_URL ??
    (network === "pubnet"
      ? "https://mainnet.sorobanrpc.com"
      : "https://soroban-testnet.stellar.org");
  return { network, rpcUrl };
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

async function dumpResponse(res: Response, jsonMode: boolean) {
  if (!res.ok) {
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
 * Actual payment flow. Takes a fully-constructed signerConfig as a
 * parameter — this function does NOT read process.env. All network I/O
 * lives here; config loading is done by the caller.
 */
async function runPayFlow(
  args: CliArgs,
  signerConfig: SignerConfig,
): Promise<void> {
  const init: RequestInit = {
    method: args.method,
    headers: args.body ? { "Content-Type": "application/json" } : undefined,
    body: args.body,
  };

  let res = await fetch(args.url!, init);
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

  const amountUsd = parseFloat(humanAmount);
  if (signerConfig.network === "pubnet" && !args.yes && amountUsd > args.maxAutoUsd) {
    const ok = await promptConfirm(
      `Pay $${humanAmount} USDC on mainnet? (yes/no) `,
    );
    if (!ok) {
      console.error("Aborted.");
      process.exit(0);
    }
  }

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

  await dumpResponse(res, args.json);
}

/**
 * Entry point. CLI parsing + env loading ONLY — no fetch calls.
 * Hands a fully-constructed signerConfig to runPayFlow.
 */
async function main() {
  const args = parseArgs();
  if (!args.url) {
    console.error("Usage: pay-per-call.ts <url> [--method POST] [--body '{...}']");
    process.exit(1);
  }

  const secret = loadSecret();
  const netCfg = readNetworkConfig();
  const signerConfig: SignerConfig = {
    secret,
    network: netCfg.network,
    rpcUrl: netCfg.rpcUrl,
  };

  await runPayFlow(args, signerConfig);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
