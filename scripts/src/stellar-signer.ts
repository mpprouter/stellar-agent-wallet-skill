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
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

// Strkey for the 32-byte all-zeros ed25519 pubkey.
// Used as a placeholder source account in sponsored simulations —
// the facilitator rebuilds the envelope with its own source before
// submission, so this value never appears on-chain.
//
// Must be exactly 56 chars. Verified at module load to fail fast
// if this literal ever gets corrupted again.
const ALL_ZEROS_PUBKEY =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

if (!StrKey.isValidEd25519PublicKey(ALL_ZEROS_PUBKEY)) {
  throw new Error(
    "ALL_ZEROS_PUBKEY is not a valid Stellar strkey — " +
      "this is a compile-time bug in scripts/src/stellar-signer.ts.",
  );
}

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
  const server = new rpc.Server(config.rpcUrl, { allowHttp: false });

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

  const sim = await server.simulateTransaction(builtTx);
  if (rpc.Api.isSimulationError(sim)) {
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

  const preparedTx = rpc.assembleTransaction(builtTx, sim).build();

  // Patch the signed auth entries onto the host function op.
  //
  // In SDK v15, preparedTx.operations[0] is a high-level Operation object
  // ({ type, func, auth }) with NO .body() method and no toXDR path that
  // re-serializes mutations. So we round-trip through the transaction
  // envelope XDR, where operations[] are xdr.Operation instances that
  // expose .body().invokeHostFunctionOp().auth(...).
  //
  // Probe-verified against @stellar/stellar-sdk@15.0.1:
  //   envelope.switch().name === "envelopeTypeTx"
  //   envelope.v1().tx().operations()[0].body().invokeHostFunctionOp().auth
  const envelope = preparedTx.toEnvelope();
  envelope
    .v1()
    .tx()
    .operations()[0]
    .body()
    .invokeHostFunctionOp()
    .auth(signedAuthEntries);

  return {
    transactionXdr: envelope.toXDR("base64"),
    signerPubkey,
    validUntilLedger,
  };
}
