/**
 * swap-xlm-to-usdc — swap XLM for USDC on the Stellar Classic DEX.
 *
 * Two modes:
 *   1. "I want to spend N XLM"   → --xlm <amount>   (strict send)
 *   2. "I want to receive N USDC" → --usdc <amount>  (strict receive)
 *
 * Usage:
 *   npx tsx commands/check-balance/swap-xlm-to-usdc.ts --xlm 10
 *   npx tsx commands/check-balance/swap-xlm-to-usdc.ts --usdc 1
 *   npx tsx commands/check-balance/swap-xlm-to-usdc.ts --usdc 5 --slippage 0.02
 *   npx tsx commands/check-balance/swap-xlm-to-usdc.ts 10      # backwards compat: positional = XLM amount
 *
 * Confirmation gates:
 *   - Mainnet always prompts unless --yes.
 *   - Any swap above 50,000 XLM or 10,000 USDC always prompts even on testnet.
 *
 * Default slippage: 1%.
 */

import "dotenv/config";
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import * as readline from "node:readline/promises";

const USDC_ISSUERS: Record<string, string> = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  pubnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

// Hard confirmation thresholds — always prompt above these, regardless of network
const LARGE_XLM_THRESHOLD = 50_000;
const LARGE_USDC_THRESHOLD = 10_000;

interface Args {
  mode: "xlm" | "usdc";
  amount: string;
  slippage: number;
  yes: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let mode: "xlm" | "usdc" | null = null;
  let amount: string | null = null;
  let slippage = 0.01;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--xlm") {
      mode = "xlm";
      amount = argv[++i];
    } else if (a === "--usdc") {
      mode = "usdc";
      amount = argv[++i];
    } else if (a === "--slippage") {
      slippage = parseFloat(argv[++i]);
    } else if (a === "--yes" || a === "-y") {
      yes = true;
    } else if (!a.startsWith("--") && !amount) {
      // Backwards-compat: positional first arg = XLM amount
      mode = "xlm";
      amount = a;
    }
  }

  if (!amount || !mode) {
    console.error("Usage:");
    console.error("  swap-xlm-to-usdc.ts --xlm <amount>      # spend N XLM");
    console.error("  swap-xlm-to-usdc.ts --usdc <amount>     # receive N USDC");
    console.error("");
    console.error("Options:");
    console.error("  --slippage 0.01     # default 1%");
    console.error("  --yes               # skip confirmation (mainnet still prompts above thresholds)");
    process.exit(1);
  }

  const n = parseFloat(amount);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Invalid amount: ${amount}`);
    process.exit(1);
  }

  return { mode, amount, slippage, yes };
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(prompt);
  rl.close();
  return ans.trim().toLowerCase() === "yes";
}

async function main() {
  const args = parseArgs();

  const secret = process.env.STELLAR_SECRET;
  if (!secret) throw new Error("STELLAR_SECRET required in .env");

  const network = (process.env.STELLAR_NETWORK ?? "pubnet") as
    | "testnet"
    | "pubnet";
  const horizonUrl =
    process.env.STELLAR_HORIZON_URL ??
    (network === "pubnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org");
  const passphrase = network === "pubnet" ? Networks.PUBLIC : Networks.TESTNET;

  const keypair = Keypair.fromSecret(secret);
  const pubkey = keypair.publicKey();
  const horizon = new Horizon.Server(horizonUrl);

  const issuer = USDC_ISSUERS[network];
  const usdc = new Asset("USDC", issuer);

  // Preflight: trustline must exist
  const account = await horizon.loadAccount(pubkey);
  const hasTrustline = account.balances.some(
    (b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === issuer,
  );
  if (!hasTrustline) {
    console.error("❌ No USDC trustline on this account.");
    console.error("   Run: npx tsx commands/check-balance/add-trustline.ts");
    process.exit(1);
  }

  let xlmAmount: string;
  let usdcAmount: string;
  let hops: any[] = [];
  let opBuilder: any;

  if (args.mode === "xlm") {
    // Strict-send: "I'll spend N XLM, give me as much USDC as possible"
    console.log(`Quoting swap: spend ${args.amount} XLM → receive USDC on ${network}...`);
    const paths = await horizon
      .strictSendPaths(Asset.native(), args.amount, [usdc])
      .call();
    if (paths.records.length === 0) {
      console.error("❌ No swap path found — insufficient DEX liquidity.");
      process.exit(1);
    }
    const best = paths.records.sort(
      (a, b) => parseFloat(b.destination_amount) - parseFloat(a.destination_amount),
    )[0];

    xlmAmount = args.amount;
    const quoted = parseFloat(best.destination_amount);
    usdcAmount = quoted.toFixed(7);
    const minUsdc = (quoted * (1 - args.slippage)).toFixed(7);
    hops = best.path;

    console.log("");
    console.log(`  Send:         ${xlmAmount} XLM`);
    console.log(`  Quote:        ${usdcAmount} USDC`);
    console.log(`  Min receive:  ${minUsdc} USDC (${(args.slippage * 100).toFixed(1)}% slippage)`);
    console.log(`  Path hops:    ${hops.length}`);
    console.log("");

    opBuilder = () =>
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: xlmAmount,
        destination: pubkey,
        destAsset: usdc,
        destMin: minUsdc,
        path: hops.map((p: any) =>
          p.asset_type === "native"
            ? Asset.native()
            : new Asset(p.asset_code, p.asset_issuer),
        ),
      });
  } else {
    // Strict-receive: "I want exactly N USDC, how much XLM does that cost?"
    console.log(`Quoting swap: receive exactly ${args.amount} USDC → send XLM on ${network}...`);
    const paths = await horizon
      .strictReceivePaths([Asset.native()], usdc, args.amount)
      .call();
    if (paths.records.length === 0) {
      console.error("❌ No swap path found — insufficient DEX liquidity.");
      process.exit(1);
    }
    const best = paths.records.sort(
      (a, b) => parseFloat(a.source_amount) - parseFloat(b.source_amount),
    )[0];

    usdcAmount = args.amount;
    const quoted = parseFloat(best.source_amount);
    xlmAmount = quoted.toFixed(7);
    const maxXlm = (quoted * (1 + args.slippage)).toFixed(7);
    hops = best.path;

    console.log("");
    console.log(`  Receive:      ${usdcAmount} USDC (exact)`);
    console.log(`  Quote:        ${xlmAmount} XLM`);
    console.log(`  Max spend:    ${maxXlm} XLM (${(args.slippage * 100).toFixed(1)}% slippage)`);
    console.log(`  Path hops:    ${hops.length}`);
    console.log("");

    opBuilder = () =>
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: maxXlm,
        destination: pubkey,
        destAsset: usdc,
        destAmount: usdcAmount,
        path: hops.map((p: any) =>
          p.asset_type === "native"
            ? Asset.native()
            : new Asset(p.asset_code, p.asset_issuer),
        ),
      });
  }

  // Confirmation gates
  const xlmNum = parseFloat(xlmAmount);
  const usdcNum = parseFloat(usdcAmount);
  const isLarge = xlmNum >= LARGE_XLM_THRESHOLD || usdcNum >= LARGE_USDC_THRESHOLD;

  if (isLarge) {
    console.log(
      `⚠️  Large swap threshold hit (> ${LARGE_XLM_THRESHOLD} XLM or > ${LARGE_USDC_THRESHOLD} USDC).`,
    );
    const ok = await confirm("Confirm large swap? (yes/no) ");
    if (!ok) {
      console.log("Aborted.");
      process.exit(0);
    }
  } else if (network === "pubnet" && !args.yes) {
    const ok = await confirm("Confirm mainnet swap? (yes/no) ");
    if (!ok) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(opBuilder())
    .setTimeout(60)
    .build();

  tx.sign(keypair);
  const result = await horizon.submitTransaction(tx);

  console.log("");
  console.log(`✅ Swap executed`);
  console.log(`   Tx hash: ${result.hash}`);
  console.log(
    `   View:    https://stellar.expert/explorer/${network === "pubnet" ? "public" : "testnet"}/tx/${result.hash}`,
  );
}

main().catch((err) => {
  if (err?.response?.data) {
    console.error("Horizon error:", JSON.stringify(err.response.data, null, 2));
  } else {
    console.error(err);
  }
  process.exit(1);
});
