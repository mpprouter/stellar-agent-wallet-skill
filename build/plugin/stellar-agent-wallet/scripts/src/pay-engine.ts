/**
 * Pay-per-call engine — pure library that orchestrates:
 *   1. Initial fetch
 *   2. Parse 402 challenge (x402 or MPP dialect)
 *   3. Sign the inner XDR
 *   4. Retry with the payment header
 *
 * All configuration (network, rpcUrl, secret) is passed in via
 * `SignerConfig` from the caller. This module takes no external state
 * and is a pure library.
 */

import * as mppx from "mppx";
import { signSacTransfer, type SignerConfig } from "./stellar-signer.js";
import { encodeX402Header, wrapX402, assertSponsored } from "./x402.js";
import {
  encodeMppHeader,
  type MppChallenge,
  type MppChargeRequest,
} from "./mpp-envelope.js";

export interface ParsedChallenge {
  dialect: "x402" | "mpp";
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  raw: unknown;
}

/**
 * Parse a 402 response into a structured challenge.
 *
 * Priority order when a server emits multiple dialects (MPP Router does
 * this — it emits both in parallel, each routed to a different payTo
 * address via HMAC-bound credentials). We always pick MPP first:
 *
 *   1. MPP dialect — `WWW-Authenticate: Payment request="<base64>"` header
 *   2. x402 dialect — `Payment-Required: <base64>` response header
 *      (x402 v2 spec — this is the current MPP Router shape)
 *   3. x402 legacy — `accepts[]` envelope inside the JSON response body
 *      (older x402 servers)
 *
 * See skills/pay-per-call/SKILL.md for the rationale.
 */
export async function parse402(res: Response): Promise<ParsedChallenge | null> {
  // 1. MPP dialect — WWW-Authenticate: Payment <auth-params>.
  //
  // Delegated to `mppx.Challenge.deserialize`. It walks the full RFC 7235
  // auth-params (quoted-string aware, handles multi-scheme headers),
  // base64url-decodes the nested `request` and `opaque` fields into
  // structured values, and runs zod validation via Challenge.Schema.
  // On success we hand the resulting `Challenge` directly to the
  // credential serializer, so the HMAC-bound `id` round-trips byte-for-byte.
  const wwwAuth = res.headers.get("www-authenticate");
  if (wwwAuth) {
    try {
      const mppChallenge = mppx.Challenge.deserialize(wwwAuth);
      const req = mppChallenge.request as MppChargeRequest;
      return {
        dialect: "mpp",
        amount: req.amount,
        asset: req.currency,
        payTo: req.recipient,
        maxTimeoutSeconds:
          (req.methodDetails?.maxTimeoutSeconds as number | undefined) ?? 60,
        raw: mppChallenge,
      };
    } catch {
      // Not a Payment scheme, or missing/invalid request param — fall
      // through to the x402 branches.
    }
  }

  // 2. x402 v2 dialect — Payment-Required response header.
  //    MPP Router emits this alongside the application/problem+json body.
  //    The header value is a base64-encoded x402 envelope
  //    { x402Version, error, accepts: [PaymentRequirements, ...] }.
  const paymentRequiredHeader = res.headers.get("payment-required");
  if (paymentRequiredHeader) {
    try {
      const decoded = Buffer.from(paymentRequiredHeader, "base64").toString(
        "utf8",
      );
      const body = JSON.parse(decoded);
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
      // header present but not a decodable x402 envelope — fall through
    }
  }

  // 3. x402 legacy dialect — envelope inside JSON response body.
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
