/**
 * Payment-Receipt decoding — pure library.
 *
 * A 402 server returns the settlement proof in the `Payment-Receipt`
 * response header as a dot-separated, base64url-encoded token. The exact
 * segment layout differs per dialect (single-segment payload vs. classic
 * JWT header.payload.signature), so we decode every segment that parses
 * as a JSON object and merge them. Signature segments simply fail to
 * parse and are skipped.
 *
 * Everything here is best-effort: a receipt we cannot decode yields an
 * empty summary rather than an error, so a successful payment is never
 * reported as a failure because of a cosmetic parsing problem.
 */

import { baseUnitsToUsdc } from "./pay-engine.js";

export interface ReceiptSummary {
  /** Stellar transaction hash, if the receipt carries one. */
  txHash?: string;
  /** USDC amount as a human string, converted from base units when needed. */
  amount?: string;
  /** Destination account the payment settled to. */
  payTo?: string;
  /** ISO-8601 timestamp, converted from unix seconds when needed. */
  timestamp?: string;
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  if (!segment) return null;
  try {
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const text = Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function decodeReceipt(receipt: string): ReceiptSummary {
  const merged: Record<string, unknown> = {};
  for (const segment of receipt.split(".")) {
    const obj = decodeBase64UrlJson(segment);
    if (obj) Object.assign(merged, obj);
  }

  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = merged[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return undefined;
  };

  // Servers report either human USDC ("0.025") or base units ("250000").
  const rawAmount = str("amount", "maxAmountRequired", "value");
  const amount =
    rawAmount && /^\d+$/.test(rawAmount) ? baseUnitsToUsdc(rawAmount) : rawAmount;

  const rawTimestamp = str("timestamp", "iat", "settledAt");
  const timestamp =
    rawTimestamp && /^\d{9,10}$/.test(rawTimestamp)
      ? new Date(Number(rawTimestamp) * 1000).toISOString()
      : rawTimestamp;

  return {
    txHash: str("reference", "transaction", "txHash", "tx_hash", "hash"),
    amount,
    payTo: str("payTo", "pay_to", "destination", "to", "recipient"),
    timestamp,
  };
}

export function explorerUrl(
  txHash: string,
  network: "testnet" | "pubnet",
): string {
  const segment = network === "pubnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${segment}/tx/${txHash}`;
}
