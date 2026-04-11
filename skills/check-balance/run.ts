/**
 * check-balance — read Stellar USDC + XLM for an account.
 *
 * Usage:
 *   npx tsx skills/check-balance/run.ts [G... pubkey] [--json] [base flags]
 *
 * If no pubkey given, derives it from the --secret-file (default
 * .stellar-secret in cwd).
 *
 * Base flags (from scripts/src/cli-config.ts):
 *   --secret-file <path>    default: .stellar-secret
 *   --network <name>        testnet|pubnet, default: pubnet
 *   --horizon-url <url>     override Horizon endpoint
 *   --rpc-url <url>         override Soroban RPC endpoint
 *   --asset-sac <addr>      Stellar Asset Contract address
 */

import {
  Horizon,
  Keypair,
  rpc,
  Address,
  Contract,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  Account,
  Networks,
} from "@stellar/stellar-sdk";
import { parseBase, type BaseConfig } from "../../scripts/src/cli-config.js";
import { loadSecretFromFile } from "../../scripts/src/secret.js";

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

const CLASSIC_USDC_ISSUERS: Record<string, string> = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  pubnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

interface RunInputs {
  base: BaseConfig;
  pubkey: string;
  jsonOutput: boolean;
}

/**
 * Parse argv, resolve the account pubkey (either from CLI positional
 * argument, or by deriving from a secret file), and return plain inputs
 * for the runner. Performs no outbound calls.
 */
function resolveInputs(): RunInputs {
  const { base, rest } = parseBase(process.argv.slice(2));
  const jsonOutput = rest.includes("--json");
  const positional = rest.filter((a) => a !== "--json");

  let pubkey = positional[0];
  if (!pubkey) {
    const secret = loadSecretFromFile(base.secretFile);
    pubkey = Keypair.fromSecret(secret).publicKey();
    // secret binding goes out of scope here
  }

  return { base, pubkey, jsonOutput };
}

async function runCheck(inputs: RunInputs): Promise<BalanceReport> {
  const { base, pubkey } = inputs;
  const horizon = new Horizon.Server(base.horizonUrl);
  const balances: BalanceLine[] = [];
  let reserveXlm = "0";
  let xlmClassic = "0";

  try {
    const account = await horizon.loadAccount(pubkey);
    for (const b of account.balances) {
      if (b.asset_type === "native") {
        xlmClassic = b.balance;
        balances.push({ asset: "XLM", amount: b.balance, source: "classic" });
      } else if (
        "asset_code" in b &&
        b.asset_code === "USDC" &&
        b.asset_issuer === CLASSIC_USDC_ISSUERS[base.network]
      ) {
        balances.push({ asset: "USDC", amount: b.balance, source: "classic" });
      }
    }
    const subentries = account.subentry_count;
    const reserveXlmNum = 1 + 0.5 * subentries;
    reserveXlm = reserveXlmNum.toFixed(7);
  } catch (err: any) {
    if (err?.response?.status === 404) {
      console.error(`Account ${pubkey} not found on ${base.network}.`);
      if (base.network === "testnet") {
        console.error(
          `Fund it: curl "https://friendbot.stellar.org?addr=${pubkey}"`,
        );
      }
      process.exit(1);
    }
    throw err;
  }

  if (base.assetSac) {
    try {
      const sacAmount = await readSacBalance(
        base.rpcUrl,
        base.assetSac,
        pubkey,
        base.network,
      );
      if (sacAmount !== null) {
        const humanAmount = (Number(sacAmount) / 10_000_000).toFixed(7);
        balances.push({ asset: "USDC", amount: humanAmount, source: "sac" });
      }
    } catch (err) {
      if (!inputs.jsonOutput) {
        console.error(`(SAC balance read failed: ${(err as Error).message})`);
      }
    }
  }

  const spendableXlm = (Number(xlmClassic) - Number(reserveXlm)).toFixed(7);

  return {
    account: pubkey,
    network: base.network,
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
  const server = new rpc.Server(rpcUrl, { allowHttp: false });
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

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
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
  const inputs = resolveInputs();
  const report = await runCheck(inputs);
  renderReport(report, inputs.jsonOutput);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
