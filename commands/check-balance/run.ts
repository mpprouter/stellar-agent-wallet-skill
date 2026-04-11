/**
 * check-balance — read Stellar USDC + XLM for an account.
 *
 * Usage:
 *   npx tsx commands/check-balance/run.ts [G... pubkey] [--json]
 *
 * If no pubkey given, derives it from STELLAR_SECRET in .env.
 *
 * Env contract (loaded in readConfig, not in any fetch function):
 *   STELLAR_NETWORK      optional (default: pubnet)
 *   STELLAR_HORIZON_URL  optional
 *   STELLAR_RPC_URL      optional
 *   STELLAR_ASSET_SAC    optional
 *   STELLAR_SECRET       optional — only if no pubkey passed on CLI
 */

import "dotenv/config";
import {
  Horizon,
  Keypair,
  SorobanRpc,
  Address,
  Contract,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  Account,
  Networks,
} from "@stellar/stellar-sdk";

interface BalanceLine {
  asset: string;
  amount: string;
  source: "classic" | "sac";
}

interface BalanceReport {
  account: string;
  network: "testnet" | "pubnet";
  balances: BalanceLine[];
  reserveXlm: string;
  spendableXlm: string;
}

interface RuntimeConfig {
  network: "testnet" | "pubnet";
  horizonUrl: string;
  rpcUrl: string;
  sacAddress?: string;
  pubkey: string;
  jsonOutput: boolean;
}

const CLASSIC_USDC_ISSUERS: Record<string, string> = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  pubnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

/**
 * Build the runtime config from argv + env. No fetch calls.
 */
function readConfig(): RuntimeConfig {
  const args = process.argv.slice(2).filter((a) => a !== "--json");
  const jsonOutput = process.argv.includes("--json");

  const network = (process.env.STELLAR_NETWORK ?? "pubnet") as
    | "testnet"
    | "pubnet";
  const horizonUrl =
    process.env.STELLAR_HORIZON_URL ??
    (network === "pubnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org");
  const rpcUrl =
    process.env.STELLAR_RPC_URL ??
    (network === "pubnet"
      ? "https://mainnet.sorobanrpc.com"
      : "https://soroban-testnet.stellar.org");
  const sacAddress = process.env.STELLAR_ASSET_SAC;

  let pubkey = args[0];
  if (!pubkey) {
    const secret = process.env.STELLAR_SECRET;
    if (!secret) {
      console.error(
        "No pubkey given and STELLAR_SECRET not set. Run:",
        "  npx tsx commands/check-balance/run.ts G...",
      );
      process.exit(1);
    }
    pubkey = Keypair.fromSecret(secret).publicKey();
    // secret out of scope now
  }

  return { network, horizonUrl, rpcUrl, sacAddress, pubkey, jsonOutput };
}

/**
 * Runtime flow. No process.env reads.
 * Takes plain config as an argument and performs all network I/O.
 */
async function runCheck(cfg: RuntimeConfig): Promise<BalanceReport> {
  const horizon = new Horizon.Server(cfg.horizonUrl);
  const balances: BalanceLine[] = [];
  let reserveXlm = "0";
  let xlmClassic = "0";

  try {
    const account = await horizon.loadAccount(cfg.pubkey);
    for (const b of account.balances) {
      if (b.asset_type === "native") {
        xlmClassic = b.balance;
        balances.push({ asset: "XLM", amount: b.balance, source: "classic" });
      } else if (
        "asset_code" in b &&
        b.asset_code === "USDC" &&
        b.asset_issuer === CLASSIC_USDC_ISSUERS[cfg.network]
      ) {
        balances.push({ asset: "USDC", amount: b.balance, source: "classic" });
      }
    }
    const subentries = account.subentry_count;
    const reserveXlmNum = 1 + 0.5 * subentries;
    reserveXlm = reserveXlmNum.toFixed(7);
  } catch (err: any) {
    if (err?.response?.status === 404) {
      console.error(`Account ${cfg.pubkey} not found on ${cfg.network}.`);
      if (cfg.network === "testnet") {
        console.error(
          `Fund it: curl "https://friendbot.stellar.org?addr=${cfg.pubkey}"`,
        );
      }
      process.exit(1);
    }
    throw err;
  }

  if (cfg.sacAddress) {
    try {
      const sacAmount = await readSacBalance(
        cfg.rpcUrl,
        cfg.sacAddress,
        cfg.pubkey,
        cfg.network,
      );
      if (sacAmount !== null) {
        const humanAmount = (Number(sacAmount) / 10_000_000).toFixed(7);
        balances.push({ asset: "USDC", amount: humanAmount, source: "sac" });
      }
    } catch (err) {
      if (!cfg.jsonOutput) {
        console.error(`(SAC balance read failed: ${(err as Error).message})`);
      }
    }
  }

  const spendableXlm = (Number(xlmClassic) - Number(reserveXlm)).toFixed(7);

  return {
    account: cfg.pubkey,
    network: cfg.network,
    balances,
    reserveXlm,
    spendableXlm,
  };
}

async function readSacBalance(
  rpcUrl: string,
  sacAddress: string,
  accountPubkey: string,
  network: "testnet" | "pubnet",
): Promise<bigint | null> {
  const rpc = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
  const networkPassphrase =
    network === "pubnet" ? Networks.PUBLIC : Networks.TESTNET;
  const contract = new Contract(sacAddress);

  const op = contract.call(
    "balance",
    nativeToScVal(Address.fromString(accountPubkey), { type: "address" }),
  );

  const source = new Account(accountPubkey, "0");
  const tx = new TransactionBuilder(source, { fee: "0", networkPassphrase })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    return null;
  }
  const retval = (sim as any).result?.retval;
  if (!retval) return null;
  const native = scValToNative(retval);
  return typeof native === "bigint" ? native : BigInt(native);
}

function renderReport(report: BalanceReport, jsonOutput: boolean) {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Account: ${report.account}`);
  console.log(`Network: ${report.network}`);
  console.log("");
  for (const b of report.balances) {
    const tag = b.source === "sac" ? "(SAC — Soroban)" : "(Classic)";
    console.log(`  ${b.asset.padEnd(6)} ${b.amount.padStart(14)}    ${tag}`);
  }
  console.log("");
  console.log(`Reserves: ${report.reserveXlm} XLM`);
  console.log(`Spendable XLM: ${report.spendableXlm}`);
}

async function main() {
  const cfg = readConfig();
  const report = await runCheck(cfg);
  renderReport(report, cfg.jsonOutput);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
