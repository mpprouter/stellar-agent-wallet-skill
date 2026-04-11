/**
 * pay-per-call — call a 402-gated endpoint and pay with Stellar USDC.
 *
 * Supports two 402 dialects:
 *   1. x402 — { x402Version, accepts: [PaymentRequirements] } in response body
 *   2. MPP Router — WWW-Authenticate: Payment request=<base64-json> header
 *
 * Both produce the same sponsored SAC transfer XDR; only the envelope differs.
 *
 * Usage:
 *   npx tsx commands/pay-per-call/run.ts <url> [--method POST] [--body '{}'] [--json] [--yes]
 */

import "dotenv/config";

interface Args {
  url?: string;
  method: string;
  body?: string;
  json: boolean;
  yes: boolean;
  maxAutoUsd: number;
  receiptOut?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = { method: "GET", json: false, yes: false, maxAutoUsd: 0.1 };
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

interface ParsedChallenge {
  dialect: "x402" | "mpp";
  amount: string; // base units i128 string
  asset: string;  // SAC contract address
  payTo: string;
  maxTimeoutSeconds: number;
  raw: unknown;
}

async function parse402(res: Response): Promise<ParsedChallenge | null> {
  // MPP dialect: WWW-Authenticate header
  const wwwAuth = res.headers.get("www-authenticate");
  if (wwwAuth && wwwAuth.toLowerCase().startsWith("payment")) {
    const match = wwwAuth.match(/request=([A-Za-z0-9+/=_-]+)/);
    if (match) {
      const decoded = Buffer.from(match[1], "base64url").toString("utf8");
      const challenge = JSON.parse(decoded);
      return {
        dialect: "mpp",
        amount: challenge.amount,
        asset: challenge.currency,
        payTo: challenge.recipient,
        maxTimeoutSeconds: challenge.methodDetails?.maxTimeoutSeconds ?? 60,
        raw: challenge,
      };
    }
  }

  // x402 dialect: body contains { x402Version, accepts }
  try {
    const body: any = await res.clone().json();
    if (body?.accepts?.[0]?.scheme === "exact") {
      const r = body.accepts[0];
      return {
        dialect: "x402",
        amount: r.amount,
        asset: r.asset,
        payTo: r.payTo,
        maxTimeoutSeconds: r.maxTimeoutSeconds ?? 60,
        raw: body,
      };
    }
  } catch {
    // not JSON
  }

  return null;
}

/**
 * Sign the inner XDR using the client.ts signer from templates/.
 * At runtime, this is scaffolded as src/stellar-client.ts in the user's project.
 */
async function signInnerXdr(challenge: ParsedChallenge): Promise<{
  transactionXdr: string;
  signerPubkey: string;
}> {
  // Import the scaffolded client (expected path after skill scaffolds files)
  const clientModule = await import(
    /* @vite-ignore */ process.cwd() + "/src/stellar-client.js"
  ).catch(() =>
    import(/* @vite-ignore */ process.cwd() + "/src/stellar-client.ts"),
  );
  const signer = clientModule.signerFromEnv();
  const signed = await signer.signPayment({
    assetSac: challenge.asset,
    payTo: challenge.payTo,
    amountBaseUnits: challenge.amount,
    maxTimeoutSeconds: challenge.maxTimeoutSeconds,
  });
  return signed;
}

function encodeX402Header(
  transactionXdr: string,
  network: string,
  x402Version: number,
): string {
  const payload = {
    x402Version,
    scheme: "exact",
    network,
    payload: { transaction: transactionXdr },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function encodeMppHeader(
  transactionXdr: string,
  signerPubkey: string,
  challenge: any,
): string {
  // MPP Authorization: Payment <base64-json-credential>
  // Credential shape matches mppx Credential envelope for stellar charge mode.
  const credential = {
    type: "transaction",
    transaction: transactionXdr,
    source: `did:pkh:stellar:${challenge.methodDetails?.network ?? "pubnet"}:${signerPubkey}`,
    challenge: challenge.challenge ?? null,
  };
  return "Payment " + Buffer.from(JSON.stringify(credential), "utf8").toString("base64");
}

async function main() {
  const args = parseArgs();
  if (!args.url) {
    console.error("Usage: pay-per-call.ts <url> [--method POST] [--body '{...}']");
    process.exit(1);
  }

  const init: RequestInit = {
    method: args.method,
    headers: args.body
      ? { "Content-Type": "application/json" }
      : undefined,
    body: args.body,
  };

  // First attempt
  let res = await fetch(args.url, init);
  if (res.status !== 402) {
    await dumpResponse(res, args);
    return;
  }

  const challenge = await parse402(res);
  if (!challenge) {
    console.error("❌ Got 402 but could not parse challenge.");
    console.error("   Body:", await res.text());
    process.exit(1);
  }

  // Quote display
  const network = (process.env.STELLAR_NETWORK ?? "testnet") as "testnet" | "pubnet";
  const humanAmount = (Number(challenge.amount) / 10_000_000).toFixed(7);
  console.error(`💸 Payment required (${challenge.dialect})`);
  console.error(`   Amount: ${humanAmount} USDC`);
  console.error(`   To:     ${challenge.payTo}`);
  console.error(`   Asset:  ${challenge.asset}`);
  console.error("");

  // Confirmation gate for mainnet above threshold
  const amountUsd = parseFloat(humanAmount);
  if (network === "pubnet" && !args.yes && amountUsd > args.maxAutoUsd) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(`Pay $${humanAmount} USDC on mainnet? (yes/no) `);
    rl.close();
    if (ans.trim().toLowerCase() !== "yes") {
      console.error("Aborted.");
      process.exit(0);
    }
  }

  // Sign
  const signed = await signInnerXdr(challenge);

  // Wrap + retry
  const retryHeaders = new Headers(init.headers);
  if (challenge.dialect === "x402") {
    const caip2 = network === "pubnet" ? "stellar:pubnet" : "stellar:testnet";
    const x402Version = (challenge.raw as any)?.x402Version ?? 1;
    retryHeaders.set(
      "X-Payment",
      encodeX402Header(signed.transactionXdr, caip2, x402Version),
    );
  } else {
    retryHeaders.set(
      "Authorization",
      encodeMppHeader(signed.transactionXdr, signed.signerPubkey, challenge.raw),
    );
  }

  res = await fetch(args.url, { ...init, headers: retryHeaders });

  // Receipt
  const receipt = res.headers.get("payment-receipt");
  if (receipt && args.receiptOut) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(args.receiptOut, receipt);
    console.error(`📝 Receipt saved to ${args.receiptOut}`);
  } else if (receipt) {
    console.error(`📝 Payment-Receipt: ${receipt}`);
  }

  await dumpResponse(res, args);
}

async function dumpResponse(res: Response, args: Args) {
  if (!res.ok) {
    console.error(`❌ ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }

  const ctype = res.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    const json = await res.json();
    console.log(args.json ? JSON.stringify(json) : JSON.stringify(json, null, 2));
  } else {
    console.log(await res.text());
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
