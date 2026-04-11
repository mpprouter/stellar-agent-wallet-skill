/**
 * Unified Stellar payment signer — pure library.
 *
 * All configuration passed as function arguments. Used by
 * skills/pay-per-call/run.ts after the CLI entry point loads its
 * own secret and config.
 *
 * Produces an inner transaction XDR (base64) that:
 *  - Invokes SAC `transfer(from, to, amount)`
 *  - Has source account = ALL_ZEROS placeholder
 *  - Has only Soroban auth entries signed (NOT the envelope)
 *
 * This single XDR can be wrapped in either:
 *  - an x402 PaymentPayload (see x402.ts)
 *  - an MPP Credential (see mpp-envelope.ts)
 */

import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

const ALL_ZEROS_PUBKEY =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface SignerConfig {
  /** Stellar secret key (S...). Held in memory only long enough to sign. */
  secret: string;
  network: "testnet" | "pubnet";
  rpcUrl: string;
}

export interface PaymentRequest {
  assetSac: string;
  payTo: string;
  amountBaseUnits: string;
  maxTimeoutSeconds: number;
}

export interface SignedPayment {
  transactionXdr: string;
  signerPubkey: string;
  validUntilLedger: number;
}

/**
 * Sign a SAC transfer.
 *
 * The secret is used once to construct a Keypair, held in a closure
 * for the duration of this function, and not retained afterward.
 * It is never logged, never put into URLs/headers/bodies, and never
 * returned — only the derived public key and signed XDR.
 */
export async function signSacTransfer(
  config: SignerConfig,
  req: PaymentRequest,
): Promise<SignedPayment> {
  // Local-only: the Keypair holds the secret internally.
  // It goes out of scope when this function returns.
  const keypair = Keypair.fromSecret(config.secret);
  const networkPassphrase =
    config.network === "pubnet" ? Networks.PUBLIC : Networks.TESTNET;
  const rpc = new SorobanRpc.Server(config.rpcUrl, { allowHttp: false });

  const signerPubkey = keypair.publicKey();
  const contract = new Contract(req.assetSac);

  const op = contract.call(
    "transfer",
    nativeToScVal(Address.fromString(signerPubkey), { type: "address" }),
    nativeToScVal(Address.fromString(req.payTo), { type: "address" }),
    nativeToScVal(BigInt(req.amountBaseUnits), { type: "i128" }),
  );

  const placeholderAccount = new Account(ALL_ZEROS_PUBKEY, "0");
  const builtTx = new TransactionBuilder(placeholderAccount, {
    fee: "0",
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(req.maxTimeoutSeconds)
    .build();

  const sim = await rpc.simulateTransaction(builtTx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  const latestLedger = sim.latestLedger;
  const ledgerCloseSeconds = 5;
  const validUntilLedger =
    latestLedger + Math.ceil(req.maxTimeoutSeconds / ledgerCloseSeconds);

  if (!sim.result || !sim.result.auth) {
    throw new Error("Simulation returned no auth entries");
  }

  const signedAuthEntries = await Promise.all(
    sim.result.auth.map((entry: xdr.SorobanAuthorizationEntry) =>
      authorizeEntry(entry, keypair, validUntilLedger, networkPassphrase),
    ),
  );

  const preparedTx = SorobanRpc.assembleTransaction(builtTx, sim).build();
  const opXdr = preparedTx.operations[0] as xdr.Operation<any>;
  const hostFnOp = opXdr.body().invokeHostFunctionOp();
  hostFnOp.auth(signedAuthEntries);

  return {
    transactionXdr: preparedTx.toXDR(),
    signerPubkey,
    validUntilLedger,
  };
}

/**
 * Sign a raw Stellar Classic transaction (for send-payment flow,
 * which uses the payment operation not SAC transfer).
 *
 * Same secret handling contract: secret is used once and not retained.
 */
export function signClassicTx(
  secret: string,
  txXdr: string,
  networkPassphrase: string,
): string {
  const { TransactionBuilder: TB } = require("@stellar/stellar-sdk");
  const kp = Keypair.fromSecret(secret);
  const tx = TB.fromXDR(txXdr, networkPassphrase);
  tx.sign(kp);
  return tx.toXDR();
}

/** Derive the public key from a secret without retaining the secret. */
export function pubkeyFromSecret(secret: string): string {
  return Keypair.fromSecret(secret).publicKey();
}
