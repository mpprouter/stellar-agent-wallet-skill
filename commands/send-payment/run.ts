/**
 * send-payment — cross-chain USDC/USDT payout from Stellar via Rozo.
 *
 * Wraps the Rozo intent API:
 *   POST https://intentapiv4.rozo.ai/functions/v1/payment-api/
 *
 * Flow (per Rozo spec):
 *   1. Validate destination chain + token pairing
 *   2. POST create-payment (exactOut by default) → get payment ID + deposit address + fee
 *   3. Show quote to user, confirm on mainnet
 *   4. Print instructions for funding the Stellar deposit address
 *   5. User separately sends USDC to the deposit address (Classic USDC payment
 *      or Stellar C-wallet contract pay() — this script does NOT auto-submit)
 *   6. Poll status via status.ts with the payment ID
 *
 * Usage:
 *   npx tsx commands/send-payment/run.ts \
 *     --to <address> --chain <chain> [--token USDC|USDT] --amount <decimal>
 *
 * Example:
 *   npx tsx commands/send-payment/run.ts \
 *     --to 0xAbCdEf... --chain base --token USDC --amount 10.00
 *
 * API reference: https://intentapiv4.rozo.ai/functions/v1/payment-api
 */

import "dotenv/config";
import * as readline from "node:readline/promises";

// Rozo chain ID mapping — from rozo-intents-skills/references/supported-chains.md
const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
  bsc: 56,
  polygon: 137,
  solana: 900,
  stellar: 1500,
};

// Payout token addresses (from Rozo's supported-chains.md)
const PAYOUT_TOKEN_ADDRESSES: Record<string, Record<"USDC" | "USDT", string | null>> = {
  ethereum: {
    USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    USDT: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  },
  arbitrum: {
    USDC: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    USDT: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
  },
  base: {
    USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    USDT: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base USDT via the same token if applicable — verify
  },
  bsc: {
    USDC: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    USDT: "0x55d398326f99059ff775485246999027b3197955",
  },
  polygon: {
    USDC: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    USDT: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
  },
  solana: {
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: null, // not supported as payout
  },
  stellar: {
    USDC: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    USDT: null,
  },
};

// Stellar USDC pay-in token (always this for source=stellar)
const STELLAR_USDC_PAYIN = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const MAX_AMOUNT_USD = 10_000;
const MIN_AMOUNT_USD = 0.01;

type Chain = keyof typeof CHAIN_IDS;

interface Args {
  to?: string;
  chain?: Chain;
  token: "USDC" | "USDT";
  amount?: string;
  memo?: string;
  json: boolean;
  yes: boolean;
  orderId?: string;
  title?: string;
  description?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = { token: "USDC", json: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--to") a.to = argv[++i];
    else if (k === "--chain") a.chain = argv[++i].toLowerCase() as Chain;
    else if (k === "--token") a.token = argv[++i].toUpperCase() as "USDC" | "USDT";
    else if (k === "--amount") a.amount = argv[++i];
    else if (k === "--memo") a.memo = argv[++i];
    else if (k === "--order-id") a.orderId = argv[++i];
    else if (k === "--title") a.title = argv[++i];
    else if (k === "--description") a.description = argv[++i];
    else if (k === "--json") a.json = true;
    else if (k === "--yes" || k === "-y") a.yes = true;
  }
  return a;
}

function validate(args: Args) {
  if (!args.to) throw new Error("--to <address> is required");
  if (!args.chain || !(args.chain in CHAIN_IDS)) {
    throw new Error(
      `--chain <chain> required. Valid: ${Object.keys(CHAIN_IDS).join(", ")}`,
    );
  }
  if (!args.amount) throw new Error("--amount <decimal> is required");

  const token = args.token;
  if (!PAYOUT_TOKEN_ADDRESSES[args.chain][token]) {
    throw new Error(`${token} payout is not supported on ${args.chain}. Use USDC.`);
  }

  const amount = parseFloat(args.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid amount: ${args.amount}`);
  }
  if (amount < MIN_AMOUNT_USD) throw new Error(`Minimum amount is $${MIN_AMOUNT_USD}`);
  if (amount > MAX_AMOUNT_USD) throw new Error(`Maximum per tx is $${MAX_AMOUNT_USD}`);

  return {
    to: args.to,
    chain: args.chain,
    chainId: CHAIN_IDS[args.chain],
    token,
    tokenAddress: PAYOUT_TOKEN_ADDRESSES[args.chain][token]!,
    amount: amount.toFixed(2), // Rozo expects string decimal
    memo: args.memo,
  };
}

interface RozoCreateRequest {
  appId: "rozoAgent";
  orderId?: string;
  type: "exactOut";
  display: { title: string; description?: string; currency: "USD" };
  source: {
    chainId: number;
    tokenSymbol: "USDC";
    tokenAddress: string;
    // no amount — exactOut fills this in from the response
  };
  destination: {
    chainId: number;
    receiverAddress: string;
    receiverMemo?: string;
    tokenSymbol: "USDC" | "USDT";
    tokenAddress: string;
    amount: string;
  };
}

interface RozoCreateResponse {
  id: string;
  appId: string;
  status: string;
  type: string;
  createdAt: string;
  expiresAt: string;
  source: {
    chainId: number;
    tokenSymbol: string;
    amount: string;
    receiverAddress: string;
    receiverMemo?: string;
    fee?: string;
  };
  destination: {
    chainId: number;
    receiverAddress: string;
    tokenSymbol: string;
    amount: string;
  };
}

async function createRozoPayment(body: RozoCreateRequest): Promise<RozoCreateResponse> {
  const baseUrl =
    process.env.ROZO_INTENT_URL ??
    "https://intentapiv4.rozo.ai/functions/v1/payment-api";

  const res = await fetch(`${baseUrl}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Rozo create-payment failed: ${res.status} ${text}`);
  }
  return (await res.json()) as RozoCreateResponse;
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(prompt);
  rl.close();
  return ans.trim().toLowerCase() === "yes";
}

async function main() {
  const args = parseArgs();
  const v = validate(args);

  const network = (process.env.STELLAR_NETWORK ?? "pubnet") as "testnet" | "pubnet";
  if (network !== "pubnet") {
    console.error(
      "⚠️  Rozo intent API operates on mainnet. Set STELLAR_NETWORK=pubnet in .env.",
    );
    process.exit(1);
  }

  const secret = process.env.STELLAR_SECRET;
  if (!secret) throw new Error("STELLAR_SECRET required in .env");
  const { Keypair } = await import("@stellar/stellar-sdk");
  const sourcePubkey = Keypair.fromSecret(secret).publicKey();

  console.log("=== Rozo cross-chain payment (Stellar USDC → " + v.chain + " " + v.token + ") ===");
  console.log(`  From wallet: ${sourcePubkey}`);
  console.log(`  To:          ${v.to}`);
  console.log(`  Destination: ${v.chain} (chainId ${v.chainId})`);
  console.log(`  Token:       ${v.token}`);
  console.log(`  Amount:      ${v.amount} USD (recipient receives exact)`);
  console.log("");

  const body: RozoCreateRequest = {
    appId: "rozoAgent",
    orderId: args.orderId,
    type: "exactOut",
    display: {
      title: args.title ?? `Payment to ${v.to.slice(0, 8)}...`,
      description: args.description,
      currency: "USD",
    },
    source: {
      chainId: CHAIN_IDS.stellar,
      tokenSymbol: "USDC",
      tokenAddress: STELLAR_USDC_PAYIN,
    },
    destination: {
      chainId: v.chainId,
      receiverAddress: v.to,
      receiverMemo: v.memo,
      tokenSymbol: v.token,
      tokenAddress: v.tokenAddress,
      amount: v.amount,
    },
  };

  console.log("Creating Rozo payment intent...");
  const intent = await createRozoPayment(body);

  const fee = intent.source.fee ?? "0";
  const totalSource = intent.source.amount;

  console.log("");
  console.log(`✅ Intent created`);
  console.log(`   Payment ID:  ${intent.id}`);
  console.log(`   Status:      ${intent.status}`);
  console.log(`   Expires:     ${intent.expiresAt}`);
  console.log("");
  console.log(`   You will send:     ${totalSource} USDC on Stellar`);
  console.log(`   Recipient gets:    ${intent.destination.amount} ${v.token} on ${v.chain}`);
  console.log(`   Fee:               ${fee} USDC`);
  console.log("");
  console.log(`   Deposit address:   ${intent.source.receiverAddress}`);
  if (intent.source.receiverMemo) {
    console.log(`   Deposit memo:      ${intent.source.receiverMemo}   ⚠️ REQUIRED`);
  }

  if (args.json) {
    console.log("");
    console.log(JSON.stringify(intent, null, 2));
  }

  // Confirmation gate
  if (!args.yes) {
    console.log("");
    const ok = await confirm(
      `Send ${totalSource} USDC from your Stellar wallet to the deposit address above? (yes/no) `,
    );
    if (!ok) {
      console.log("Aborted. Payment ID retained — you can fund it later before " + intent.expiresAt);
      process.exit(0);
    }
  }

  // Fund the deposit address via Stellar Classic USDC payment
  console.log("");
  console.log("Sending Stellar USDC to deposit address...");

  const { Horizon, Asset, Networks, Operation, TransactionBuilder, BASE_FEE, Memo } = await import(
    "@stellar/stellar-sdk"
  );
  const horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org";
  const horizon = new Horizon.Server(horizonUrl);
  const account = await horizon.loadAccount(sourcePubkey);

  const usdcAsset = new Asset(
    "USDC",
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  );

  const txBuilder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.payment({
        destination: intent.source.receiverAddress,
        asset: usdcAsset,
        amount: totalSource,
      }),
    )
    .setTimeout(60);

  if (intent.source.receiverMemo) {
    txBuilder.addMemo(Memo.text(intent.source.receiverMemo));
  }

  const tx = txBuilder.build();
  tx.sign(Keypair.fromSecret(secret));

  const result = await horizon.submitTransaction(tx);

  console.log("");
  console.log(`✅ Stellar payment submitted`);
  console.log(`   Stellar tx hash: ${result.hash}`);
  console.log(`   View:            https://stellar.expert/explorer/public/tx/${result.hash}`);
  console.log("");
  console.log(`Poll status: npx tsx commands/send-payment/status.ts ${intent.id}`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  if (err?.response?.data) {
    console.error("Horizon error:", JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
