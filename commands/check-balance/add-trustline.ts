/**
 * add-trustline — add a USDC Classic trustline to this account.
 *
 * You need a Classic trustline to HOLD USDC on Stellar. Note: SAC balances
 * (Soroban token contract) do NOT need a trustline — but if you want to
 * receive Classic USDC payments, swap on the DEX, or cash out, you do.
 *
 * Usage:
 *   npx tsx commands/check-balance/add-trustline.ts
 *
 * Reads STELLAR_SECRET + STELLAR_NETWORK from .env.
 * Idempotent — safe to run if the trustline already exists.
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

const USDC_ISSUERS: Record<string, string> = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  pubnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

async function main() {
  const secret = process.env.STELLAR_SECRET;
  if (!secret) throw new Error("STELLAR_SECRET required in .env");

  const network = (process.env.STELLAR_NETWORK ?? "testnet") as
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

  const account = await horizon.loadAccount(pubkey);

  // Idempotency check
  const already = account.balances.some(
    (b) =>
      "asset_code" in b &&
      b.asset_code === "USDC" &&
      b.asset_issuer === issuer,
  );
  if (already) {
    console.log(`Trustline to USDC (${network}) already exists.`);
    console.log(`  Issuer: ${issuer}`);
    return;
  }

  console.log(`Adding USDC trustline on ${network}...`);
  console.log(`  Account: ${pubkey}`);
  console.log(`  Issuer:  ${issuer}`);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(60)
    .build();

  tx.sign(keypair);
  const result = await horizon.submitTransaction(tx);

  console.log("");
  console.log(`✅ Trustline added`);
  console.log(`   Tx hash: ${result.hash}`);
  console.log(
    `   View:    https://stellar.expert/explorer/${network === "pubnet" ? "public" : "testnet"}/tx/${result.hash}`,
  );
  console.log("");
  console.log("Minimum balance increased by 0.5 XLM (one new subentry).");
}

main().catch((err) => {
  if (err?.response?.data) {
    console.error("Horizon error:", JSON.stringify(err.response.data, null, 2));
  } else {
    console.error(err);
  }
  process.exit(1);
});
