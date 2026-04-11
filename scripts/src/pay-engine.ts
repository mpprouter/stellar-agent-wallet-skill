/**
 * Pay-per-call engine — pure library that orchestrates:
 *   1. Initial fetch
 *   2. Parse 402 challenge (x402 or MPP dialect)
 *   3. Sign the inner XDR
 *   4. Retry with the payment header
 *
 * No process.env reads. All configuration (network, rpcUrl, secret) is
 * passed in via `SignerConfig` from the caller. The caller's CLI scope
 * is where env vars are read.
 */

import { signSacTransfer, type SignerConfig } from "./stellar-signer.js";
import { encodeX402Header, wrapX402, assertSponsored } from "./x402.js";
import { encodeMppHeader, type MppChallenge } from "./mpp-envelope.js";

export interface ParsedChallenge {
  dialect: "x402" | "mpp";
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  raw: unknown;
}

export async function parse402(res: Response): Promise<ParsedChallenge | null> {
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

  try {
    const body: any = await res.clone().json();
    if (body?.accepts?.[0]?.scheme === "exact") {
      const r = body.accepts[0];
      assertSponsored(r);
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
 * Build the request headers for the retry call after signing.
 *
 * The signed XDR gets wrapped in the appropriate envelope for the
 * detected 402 dialect and appended as either X-Payment (x402) or
 * Authorization: Payment (MPP).
 */
export async function buildRetryHeaders(params: {
  challenge: ParsedChallenge;
  signerConfig: SignerConfig;
  baseHeaders?: HeadersInit;
}): Promise<Headers> {
  const { challenge, signerConfig, baseHeaders } = params;

  const signed = await signSacTransfer(signerConfig, {
    assetSac: challenge.asset,
    payTo: challenge.payTo,
    amountBaseUnits: challenge.amount,
    maxTimeoutSeconds: challenge.maxTimeoutSeconds,
  });

  const headers = new Headers(baseHeaders);
  if (challenge.dialect === "x402") {
    const caip2 =
      signerConfig.network === "pubnet" ? "stellar:pubnet" : "stellar:testnet";
    const x402Version = (challenge.raw as any)?.x402Version ?? 1;
    const payload = wrapX402(signed.transactionXdr, caip2, x402Version);
    headers.set("X-Payment", encodeX402Header(payload));
  } else {
    headers.set(
      "Authorization",
      encodeMppHeader(
        signed.transactionXdr,
        signed.signerPubkey,
        challenge.raw as MppChallenge,
      ),
    );
  }
  return headers;
}

/** Convert a base-units i128 string to a human USDC decimal (7 decimals). */
export function baseUnitsToUsdc(amount: string): string {
  return (Number(amount) / 10_000_000).toFixed(7);
}
