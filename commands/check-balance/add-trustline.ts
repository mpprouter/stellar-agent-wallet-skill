/**
 * add-trustline — add a USDC Classic trustline to this account.
 *
 * You need a Classic trustline to HOLD USDC on Stellar. SAC balances
 * (Soroban token contract) do NOT need a trustline — but if you want to
 * receive Classic USDC payments, swap on the DEX, or cash out, you do.
 *
 * Usage:
 *   npx tsx commands/check-balance/add-trustline.ts
 *
 * Env contract (loaded in readConfig, not in runAddTrustline):
 *   STELLAR_SECRET       required
 *   STELLAR_NETWORK      optional (default: pubnet)
 *   STELLAR_HORIZON_URL  optional
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
import { loadSecret } from "../../scripts/src/secret.js";

const USDC_ISSUERS: Record<string, string> = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  pubnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

interface RuntimeConfig {
  secret: string;
  network: "testnet" | "pubnet";
  horizonUrl: string;
}

/**
 * Build runtime config from env. No fetch calls here.
 */
function readConfig(): RuntimeConfig {
  const secret = loadSecret();
  const network = (process.env.STELLAR_NETWORK ?? "pubnet") as
    | "testnet"
    | "pubnet";
  const horizonUrl =
    process.env.STELLAR_HORIZON_URL ??
    (network === "pubnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org");
  return { secret, network, horizonUrl };
}

/**
 * Do the actual work. No process.env reads.
 */
async function runAddTrustline(cfg: RuntimeConfig): Promise<void> {
  const passphrase =
    cfg.network === "pubnet" ? Networks.PUBLIC : Networks.TESTNET;
  const keypair = Keypair.fromSecret(cfg.secret);
  const pubkey = keypair.publicKey();
  const horizon = new Horizon.Server(cfg.horizonUrl);

  const issuer = USDC_ISSUERS[cfg.network];
  const usdc = new Asset("USDC", issuer);

  const account = await horizon.loadAccount(pubkey);

  const already = account.balances.some(
    (b) =>
      "asset_code" in b &&
      b.asset_code === "USDC" &&
      b.asset_issuer === issuer,
  );
  if (already) {
    console.log(`Trustline to USDC (${cfg.network}) already exists.`);
    console.log(`  Issuer: ${issuer}`);
    return;
  }

  console.log(`Adding USDC trustline on ${cfg.network}...`);
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
    `   View:    https://stellar.expert/explorer/${cfg.network === "pubnet" ? "public" : "testnet"}/tx/${result.hash}`,
  );
  console.log("");
  console.log("Minimum balance increased by 0.5 XLM (one new subentry).");
}

async function main() {
  const cfg = readConfig();
  await runAddTrustline(cfg);
}

main().catch((err) => {
  if (err?.response?.data) {
    console.error("Horizon error:", JSON.stringify(err.response.data, null, 2));
  } else {
    console.error(err);
  }
  process.exit(1);
});
