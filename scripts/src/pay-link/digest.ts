/**
 * Confirmation digest — the `--confirm <digest>` handshake.
 *
 * Modelled on the rozo-checkout create-order flow, which is the strongest
 * confirmation pattern we have: the tool prints a digest over exactly the
 * facts that decide where money goes, and refuses to execute until the caller
 * echoes that digest back. If any of those facts changed between the two
 * runs, the digest changes and the second run refuses rather than paying a
 * different invoice than the one that was shown.
 *
 * Digest inputs are deliberately narrow — the URL, the amount, the currency
 * and the exact deposit address + memo. A field that cannot move money (a
 * display title, an inspection timestamp) is excluded, so cosmetic upstream
 * churn does not force a pointless re-confirmation.
 */

import { createHash } from "node:crypto";
import type { UnifiedInspection } from "./types.js";

/** The subset of an inspection that a confirmation is binding over. */
export interface DigestInput {
  url: string;
  amount: string | null;
  currency: string | null;
  deposit_address: string | null;
  deposit_memo: string | null;
}

export function digestInputFrom(
  ins: UnifiedInspection,
  railIndex = 0,
): DigestInput {
  const rail = ins.rails[railIndex];
  return {
    url: ins.url,
    amount: ins.amount,
    currency: ins.currency,
    deposit_address: rail?.deposit_address ?? null,
    deposit_memo: rail?.deposit_memo ?? null,
  };
}

/** Stable 16-hex-char digest over the money-moving fields. */
export function computeDigest(input: DigestInput): string {
  const canonical = [
    input.url,
    input.amount ?? "",
    input.currency ?? "",
    (input.deposit_address ?? "").trim().toLowerCase(),
    input.deposit_memo ?? "",
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

export type ConfirmationResult =
  | { ok: true }
  | { ok: false; code: "NOT_CONFIRMED" | "CONFIRMATION_STALE" | "DEPOSIT_CHANGED"; message: string; expected: string };

/**
 * Check a supplied confirmation token against the live inspection.
 *
 * - no token                        → NOT_CONFIRMED (print the digest, stop)
 * - token that is not the digest,
 *   and the deposit target moved     → DEPOSIT_CHANGED (loudest: the address
 *                                      or amount you confirmed is not the one
 *                                      we would pay now)
 * - token that is not the digest,
 *   nothing money-moving changed     → CONFIRMATION_STALE (typo / wrong run)
 */
export function checkConfirmation(
  supplied: string | undefined,
  ins: UnifiedInspection,
  railIndex = 0,
  previous?: DigestInput,
): ConfirmationResult {
  const input = digestInputFrom(ins, railIndex);
  const expected = computeDigest(input);

  if (!supplied) {
    return {
      ok: false,
      code: "NOT_CONFIRMED",
      expected,
      message:
        `This payment is above the pre-authorised ceiling, so it needs an explicit confirmation. ` +
        `Re-run with --confirm ${expected} after checking the printed merchant, amount and deposit address.`,
    };
  }

  if (supplied === expected) return { ok: true };

  const moved =
    previous !== undefined &&
    (previous.deposit_address !== input.deposit_address ||
      previous.deposit_memo !== input.deposit_memo ||
      previous.amount !== input.amount ||
      previous.currency !== input.currency);

  if (moved) {
    return {
      ok: false,
      code: "DEPOSIT_CHANGED",
      expected,
      message:
        "The deposit target or amount changed since the digest you supplied was issued. " +
        "The old one-time address may be expired and must not be reused. Re-inspect and confirm the new digest.",
    };
  }

  return {
    ok: false,
    code: "CONFIRMATION_STALE",
    expected,
    message:
      `The supplied confirmation "${supplied}" does not match this link. ` +
      `Expected ${expected}. Re-inspect and confirm the digest printed by this run.`,
  };
}
