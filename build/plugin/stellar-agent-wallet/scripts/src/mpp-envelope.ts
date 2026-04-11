/**
 * MPP charge envelope encoder — pure library.
 *
 * Wraps a signed Stellar XDR as an mppx Credential for the
 * Authorization: Payment <base64-json> header. No network, no env reads.
 */

export interface MppChallenge {
  amount: string;
  currency: string;
  recipient: string;
  challenge?: string;
  methodDetails?: {
    network?: string;
    maxTimeoutSeconds?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Build the base64-encoded `Authorization: Payment ...` value. */
export function encodeMppHeader(
  transactionXdr: string,
  signerPubkey: string,
  challenge: MppChallenge,
): string {
  const credential = {
    type: "transaction",
    transaction: transactionXdr,
    source: `did:pkh:stellar:${challenge.methodDetails?.network ?? "pubnet"}:${signerPubkey}`,
    challenge: challenge.challenge ?? null,
  };
  return (
    "Payment " +
    Buffer.from(JSON.stringify(credential), "utf8").toString("base64")
  );
}
