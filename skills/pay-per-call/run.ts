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
  type ParsedChallenge,
} from "../../scripts/src/pay-engine.js";
import type { SignerConfig } from "../../scripts/src/stellar-signer.js";
import { parseBase, type BaseConfig } from "../../scripts/src/cli-config.js";
import { loadSecretFromFile } from "../../scripts/src/secret.js";

interface CmdArgs {
  url?: string;
  method: string;
  body?: string;
  json: boolean;
  yes: boolean;
  maxAutoUsd: number;
  receiptOut?: string;
}

function parseCmdArgs(rest: string[]): CmdArgs {
  const a: CmdArgs = { method: "GET", json: false, yes: false, maxAutoUsd: 0.1 };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === "--method") a.method = rest[++i];
    else if (k === "--body") a.body = rest[++i];
    else if (k === "--json") a.json = true;
    else if (k === "--yes" || k === "-y") a.yes = true;
    else if (k === "--max-auto") a.maxAutoUsd = parseFloat(rest[++i]);
    else if (k === "--receipt-out") a.receiptOut = rest[++i];
    else if (!k.startsWith("--") && !a.url) a.url = k;
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

async function runPayFlow(inputs: RunInputs): Promise<void> {
  const { args, signerConfig } = inputs;
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

async function main() {
  const inputs = resolveInputs();
  await runPayFlow(inputs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
